'use strict';

// Focus sessions (adapted from Daily Rhythm's Begin Focus): pick what you're working on and a length,
// then a ring grows for every stretch of focused time. Leave the app for longer than the grace period
// and the session breaks, unless "let me leave the app" is on. Shares app.js's globals.

const FOCUS_KEY = 'canopy:focus';
const FOCUS_PREFS = 'canopy:focusPrefs';
const STEP = 5, MIN_LEN = 5, MAX_LEN = 180;
const GRACE_MS = 15000;
const RINGS = 14;

let session = null;   // { subject, todayId, minutes, dateKey, startedAt, lastSeen, state, stoppedAt, away }
let focusState = 'closed';
let tickTimer = null;
let wakeLock = null;
let audio = null;
let chosenMinutes = 45;
let pickedTodayId = null;

const fx = id => document.getElementById(id);

/* ---------- persistence (the running session is per device; logged sessions sync) ---------- */

const saveSession = () => {
  try { session ? localStorage.setItem(FOCUS_KEY, JSON.stringify(session)) : localStorage.removeItem(FOCUS_KEY); } catch {}
};
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(FOCUS_PREFS)) || {}; } catch { return {}; } };
const savePrefs = p => { try { localStorage.setItem(FOCUS_PREFS, JSON.stringify(p)); } catch {} };

function logFocus(minutes, completed) {
  const t = now();
  const rec = {
    id: uid(), subject: session.subject, todayId: session.todayId, day: session.dateKey,
    planned: session.minutes, minutes, completed, startedAt: session.startedAt, updated: t,
  };
  data.focus[rec.id] = rec;
  commit();
}

/* ---------- time ---------- */

const durationMs = () => session.minutes * 60000;
const elapsedMs = (at = Date.now()) => Math.min(durationMs(), Math.max(0, at - session.startedAt));
const progressAt = at => elapsedMs(at) / durationMs();

function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Logged time rounds up to the next 5 minutes, once at least a minute has passed. */
const loggable = ms => (ms < 60000 ? 0 : Math.min(session.minutes, Math.ceil(ms / 60000 / STEP) * STEP));

/** Decide what happened while the app wasn't visible. */
function reconcile() {
  if (!session || session.state !== 'running') return;
  const t = Date.now();
  const end = session.startedAt + durationMs();
  if (t - session.lastSeen > GRACE_MS && !session.away) {
    if (session.lastSeen + GRACE_MS >= end) return complete();
    session.state = 'broken';
    session.stoppedAt = session.lastSeen;
    saveSession();
    return showFocus('broken');
  }
  if (t >= end) return complete();
  session.lastSeen = t;
  saveSession();
}

/* ---------- lifecycle ---------- */

function beginFocus() {
  const inp = fx('focusSubject');
  const subject = inp.value.trim();
  if (!subject) { inp.focus(); inp.classList.add('invalid'); return; }

  // link to a Today entry: the one you tapped, one with the same text, or a new one
  const picked = pickedTodayId && data.today[pickedTodayId];
  let todayId = picked && !picked.deleted && picked.text === subject ? pickedTodayId : null;
  todayId ||= liveToday().find(e => !e.done && e.text.toLowerCase() === subject.toLowerCase())?.id;
  todayId ||= addToday(subject)[0];

  const t = Date.now();
  const away = fx('focusAway').checked;
  session = { subject, todayId, minutes: chosenMinutes, dateKey: todayStr(), startedAt: t, lastSeen: t, state: 'running', away };
  savePrefs({ minutes: chosenMinutes, away });
  saveSession();
  prepareAudio();
  requestWakeLock();
  haptic();
  showFocus('running');
}

function complete() {
  session.state = 'done';
  session.stoppedAt = session.startedAt + durationMs();
  saveSession();
  logFocus(session.minutes, true);
  chime();
  haptic();
  showFocus('done');
}

function logPartialAndClose() {
  const min = loggable(elapsedMs(session.stoppedAt ?? Date.now()));
  if (min >= 1) logFocus(min, false);
  closeFocus();
}

function closeFocus() {
  session = null;
  saveSession();
  releaseWakeLock();
  showFocus('closed');
}

/* ---------- rendering ---------- */

function showFocus(state) {
  focusState = state;
  const el = fx('focus');
  clearInterval(tickTimer);
  tickTimer = null;

  if (state === 'closed') {
    el.hidden = true;
    document.title = 'Canopy';
    render();
    return;
  }

  el.hidden = false;
  el.dataset.state = state;
  const eyebrow = fx('focusEyebrow'), msg = fx('focusMsg'), actions = fx('focusActions');
  actions.replaceChildren();
  const button = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.append(b);
  };

  if (state === 'setup') {
    eyebrow.textContent = 'focus';
    fx('focusTime').textContent = clock(chosenMinutes * 60000);
    requestAnimationFrame(() => setDial(chosenMinutes, false));
    renderPicks();
    msg.textContent = fx('focusAway').checked
      ? 'Lock your phone if you like. The rings keep growing while you work.'
      : 'Stay in the app while you work. Step away for more than 15 seconds and the session breaks.';
    button('not now', '', closeFocus);
    button('begin', 'primary', beginFocus);
    drawRings(fx('rings'), 0);
    return;
  }

  if (state === 'running') {
    eyebrow.textContent = session.subject;
    msg.textContent = session.away ? 'One ring at a time.' : 'One ring at a time. Stay with it.';
    button('end early', '', () => showFocus('confirm'));
    tick();
    tickTimer = setInterval(tick, 1000);
    return;
  }

  if (state === 'confirm') {
    const min = loggable(elapsedMs());
    eyebrow.textContent = session.subject;
    msg.textContent = min >= 1
      ? `End now? ${min} minutes will be logged, but the rings stay unfinished.`
      : 'End now? Less than a minute has passed, so nothing will be logged.';
    button('keep going', '', () => showFocus('running'));
    button(min >= 1 ? `end & log ${min}m` : 'end', 'primary', () => { session.stoppedAt = Date.now(); logPartialAndClose(); });
    tick();
    tickTimer = setInterval(tick, 1000);
    return;
  }

  if (state === 'done') {
    const entry = data.today[session.todayId];
    eyebrow.textContent = 'finished';
    fx('focusTime').textContent = clock(durationMs());
    msg.textContent = `${session.minutes} minutes on ${session.subject}, logged.`;
    if (entry && !entry.deleted && !entry.done) {
      button('back to the day', '', closeFocus);
      button('mark it done', 'primary', () => { toggleToday(session.todayId); closeFocus(); });
    } else {
      button('back to the day', 'primary', closeFocus);
    }
    drawRings(fx('rings'), 1);
    document.title = 'Finished · Canopy';
    return;
  }

  if (state === 'broken') {
    const min = loggable(elapsedMs(session.stoppedAt));
    eyebrow.textContent = 'interrupted';
    fx('focusTime').textContent = clock(durationMs() - elapsedMs(session.stoppedAt));
    msg.textContent = min >= 1
      ? `You stepped away and the session broke. The time before still counts: ${min} minutes.`
      : 'You stepped away and the session broke.';
    if (min >= 1) {
      button('let it go', '', closeFocus);
      button(`log ${min}m`, 'primary', logPartialAndClose);
    } else {
      button('back to the day', 'primary', closeFocus);
    }
    drawRings(fx('rings'), progressAt(session.stoppedAt), { faded: true });
    releaseWakeLock();
    document.title = 'Interrupted · Canopy';
  }
}

function tick() {
  if (!session || session.state !== 'running') return;
  if (document.visibilityState === 'visible') {
    reconcile();
    if (session?.state !== 'running') return;
  }
  const left = durationMs() - elapsedMs();
  fx('focusTime').textContent = clock(left);
  document.title = `${clock(left)} · ${session.subject}`;
  drawRings(fx('rings'), progressAt());
}

// open Today entries as one-tap subjects
function renderPicks() {
  const open = liveToday().filter(e => !e.done).slice(0, 6);
  fx('focusPicks').innerHTML = open.map(e =>
    `<button type="button" class="t-chip${e.id === pickedTodayId ? ' on' : ''}" data-pick="${esc(e.id)}">${esc(e.text)}</button>`).join('');
}

/* ---------- growth rings ---------- */

const seeded = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/** Draw the rings at progress p (0…1). `faded` dims the grown part (an interrupted session). */
function drawRings(canvas, p, { faded = false } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 240;
  if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cs = getComputedStyle(canvas);
  const accent = cs.getPropertyValue('--accent').trim();
  const ghost = cs.getPropertyValue('--line2').trim();
  const c = size / 2, maxR = size / 2 - 14, r0 = maxR * 0.08, gap = (maxR - r0) / (RINGS + 1.6);
  const grown = Math.max(0, Math.min(1, p)) * RINGS;
  const full = Math.floor(grown);
  const frac = grown - full;

  // irregular but nested, like real growth rings: every ring shares one shape that drifts a little
  const ph1 = 1.3, ph2 = 4.1;
  const radius = (k, th) => {
    const base = r0 + (k + 1) * gap;
    const shape = gap * 1.6 * ((k + 1) / RINGS) * (Math.sin(3 * th + ph1) * 0.6 + Math.sin(5 * th + ph2) * 0.4);
    const drift = gap * 0.18 * Math.sin(2 * th + seeded(k) * 6.28);
    return base + shape + drift;
  };
  const point = (k, th) => { const r = radius(k, th); return [c + r * Math.cos(th), c + r * Math.sin(th)]; };
  const ring = (k, from = 0, to = Math.PI * 2) => {
    const path = new Path2D();
    const steps = Math.max(24, Math.ceil(160 * (to - from) / (Math.PI * 2)));
    for (let i = 0; i <= steps; i++) {
      const [x, y] = point(k, from + (to - from) * (i / steps) - Math.PI / 2);
      i ? path.lineTo(x, y) : path.moveTo(x, y);
    }
    return { path, end: point(k, to - Math.PI / 2) };
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = ghost;
  for (let k = 0; k < RINGS; k++) ctx.stroke(ring(k).path);

  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(2, gap * 0.38);
  for (let k = 0; k < full && k < RINGS; k++) {
    ctx.globalAlpha = (faded ? 0.35 : 1) * (0.45 + 0.55 * (k + 1) / RINGS);
    ctx.stroke(ring(k).path);
  }

  // the ring growing right now, with a glowing tip
  if (full < RINGS && frac > 0) {
    const { path, end } = ring(full, 0, frac * Math.PI * 2);
    ctx.globalAlpha = faded ? 0.35 : 1;
    ctx.stroke(path);
    if (!faded) {
      ctx.shadowColor = accent;
      ctx.shadowBlur = 12;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(end[0], end[1], ctx.lineWidth * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // the pith
  ctx.globalAlpha = faded ? 0.4 : 1;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(c, c, Math.max(2.5, r0 * 0.45), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* ---------- length dial ---------- */

const dialValues = Array.from({ length: (MAX_LEN - MIN_LEN) / STEP + 1 }, (_, i) => MIN_LEN + i * STEP);
const dialLabel = m => (m < 60 ? String(m) : `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`);
let dialStep = 0;

function buildDial() {
  fx('dial').replaceChildren(...dialValues.map(m => {
    const t = document.createElement('button');
    t.type = 'button';
    t.tabIndex = -1;
    t.className = 'dial-tick' + (m % 15 === 0 ? ' major' : '');
    t.dataset.min = m;
    t.setAttribute('aria-label', `${m} minutes`);
    if (m % 15 === 0) {
      const label = document.createElement('span');
      label.textContent = dialLabel(m);
      t.append(label);
    }
    return t;
  }));
}

function setDial(min, smooth = true) {
  const track = fx('dial');
  const i = dialValues.indexOf(Math.min(MAX_LEN, Math.max(MIN_LEN, Math.round(min / STEP) * STEP)));
  dialStep = track.firstElementChild.offsetWidth;
  track.scrollTo({ left: i * dialStep, behavior: smooth ? 'smooth' : 'instant' });
  readDial(i);
}

function readDial(i = Math.round(fx('dial').scrollLeft / (dialStep || 1))) {
  const idx = Math.min(dialValues.length - 1, Math.max(0, i));
  if (dialValues[idx] !== chosenMinutes && focusState === 'setup') haptic();
  chosenMinutes = dialValues[idx];
  const track = fx('dial');
  track.setAttribute('aria-valuenow', chosenMinutes);
  track.setAttribute('aria-valuetext', `${chosenMinutes} minutes`);
  track.querySelector('.on')?.classList.remove('on');
  track.children[idx]?.classList.add('on');
  if (focusState === 'setup') fx('focusTime').textContent = clock(chosenMinutes * 60000);
}

function wireDial() {
  const track = fx('dial');
  buildDial();
  let frame = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => readDial());
  }, { passive: true });
  track.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    track.scrollLeft += e.deltaY;
  }, { passive: false });
  track.addEventListener('click', e => {
    const t = e.target.closest('.dial-tick');
    if (t) setDial(+t.dataset.min);
  });
  track.addEventListener('keydown', e => {
    const d = { ArrowLeft: -STEP, ArrowDown: -STEP, ArrowRight: STEP, ArrowUp: STEP, PageDown: -30, PageUp: 30 }[e.key];
    if (d) { e.preventDefault(); setDial(chosenMinutes + d); }
    if (e.key === 'Home') { e.preventDefault(); setDial(MIN_LEN); }
    if (e.key === 'End') { e.preventDefault(); setDial(MAX_LEN); }
    if (e.key === 'Enter') beginFocus();
  });
}

/* ---------- wake lock & chime ---------- */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not allowed here; fine */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// the audio context has to be created during a tap (Begin) so iOS lets it play later
function prepareAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
  } catch { audio = null; }
}

function chime() {
  if (!audio) return;
  const t0 = audio.currentTime + 0.05;
  [[523.25, 0], [659.25, 0.45], [783.99, 0.9]].forEach(([freq, at]) => {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(0.09, t0 + at + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 2.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 2.3);
  });
}

/* ---------- wiring ---------- */

function openFocus(todayId = null) {
  if (focusState !== 'closed') return;
  const prefs = loadPrefs();
  chosenMinutes = Math.min(MAX_LEN, Math.max(MIN_LEN, Math.round((prefs.minutes || 45) / STEP) * STEP));
  fx('focusAway').checked = !!prefs.away;
  const entry = todayId && data.today[todayId];
  pickedTodayId = entry ? todayId : null;
  fx('focusSubject').value = entry ? entry.text : '';
  fx('focusSubject').classList.remove('invalid');
  showFocus('setup');
}

fx('focusOpen').addEventListener('click', () => openFocus());
wireDial();

fx('focusSubject').addEventListener('input', e => {
  e.target.classList.remove('invalid');
  if (pickedTodayId && data.today[pickedTodayId]?.text !== e.target.value.trim()) { pickedTodayId = null; renderPicks(); }
});
fx('focusSubject').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); beginFocus(); } });
fx('focusPicks').addEventListener('click', e => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  pickedTodayId = b.dataset.pick;
  fx('focusSubject').value = data.today[pickedTodayId]?.text || '';
  fx('focusSubject').classList.remove('invalid');
  renderPicks();
});
fx('focusAway').addEventListener('change', () => { if (focusState === 'setup') showFocus('setup'); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && focusState === 'setup') closeFocus();
  if (e.key === 'Escape' && focusState === 'confirm') showFocus('running');
});

document.addEventListener('visibilitychange', () => {
  if (!session || session.state !== 'running') return;
  if (document.visibilityState === 'hidden') {
    session.lastSeen = Date.now();
    saveSession();
  } else {
    reconcile();
    if (session?.state === 'running') { requestWakeLock(); tick(); }
  }
});

window.addEventListener('pagehide', () => {
  if (session?.state === 'running') { session.lastSeen = Date.now(); saveSession(); }
});

function redrawRings() {
  if (focusState === 'closed') return;
  const p = session ? progressAt(session.stoppedAt ?? Date.now()) : 0;
  drawRings(fx('rings'), focusState === 'done' ? 1 : p, { faded: focusState === 'broken' });
}

window.addEventListener('resize', () => {
  if (focusState === 'setup') setDial(chosenMinutes, false);
  redrawRings();
});
// the rings grow from the small setup size; redraw crisply once that animation ends
fx('rings').parentElement.addEventListener('transitionend', redrawRings);

// resume a session that survived a reload or the app being closed
try { session = JSON.parse(localStorage.getItem(FOCUS_KEY)); } catch { session = null; }
if (session?.state === 'running') {
  showFocus('running');
  reconcile();
  if (session?.state === 'running') requestWakeLock();
} else if (session?.state === 'broken' || session?.state === 'done') {
  showFocus(session.state);
} else {
  session = null;
  saveSession();
}
