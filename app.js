'use strict';

/* ---------- constants ---------- */

const FILE = 'canopy.json';
const GEM = 'https://generativelanguage.googleapis.com/v1beta';
const CLAUDE_MODEL = 'claude-haiku-5-5';
const CLAUDE_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
const LS = { data: 'canopy:data', cfg: 'canopy:cfg', device: 'canopy:device', view: 'canopy:view', theme: 'canopy:theme', brief: 'canopy:brief' };
const DAY_MS = 86400000;
const STALE_DAYS = 21;
const TOMBSTONE_DAYS = 30;

const KINDS = {
  do:   { label: 'Do',           short: 'Do',        glyph: '◆' },
  look: { label: 'Look into',    short: 'Look into', glyph: '◎' },
  get:  { label: 'Get',          short: 'Get',       glyph: '◇' },
  read: { label: 'Read / Watch', short: 'Read',      glyph: '▤' },
  idea: { label: 'Idea',         short: 'Ideas',     glyph: '✦' },
};

/* ---------- small helpers ---------- */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayStr = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

/* ---------- state ---------- */

let data = readJSON(LS.data, null) || { v: 1, items: {}, examples: [] };
data.items ||= {};
data.today ||= {};
data.examples ||= [];

// aiKey / aiModel are the Gemini settings (named before Claude was added)
let cfg = Object.assign({ ghToken: '', gistId: '', provider: 'claude', claudeKey: '', aiKey: '', aiModel: '', aiOn: true }, readJSON(LS.cfg, {}));
const saveCfg = () => writeJSON(LS.cfg, cfg);

const deviceId = (() => {
  let d = null;
  try { d = localStorage.getItem(LS.device); } catch {}
  if (!d) { d = uid(); try { localStorage.setItem(LS.device, d); } catch {} }
  return d;
})();

let view = (() => { try { return localStorage.getItem(LS.view) || 'all'; } catch { return 'all'; } })();
let openId = null;
const fresh = new Set();
const freshToday = new Set();
let editTodayId = null;
let aiStatus = '';

const providerKey = c => (c.provider === 'gemini' ? c.aiKey : c.claudeKey);
const aiReady = () => !!(cfg.aiOn && providerKey(cfg));
const live = () => Object.values(data.items).filter(i => !i.deleted);

/* ---------- items ---------- */

function makeItem(p) {
  const t = now();
  return {
    id: uid(), title: '', kind: 'do', tags: [], group: null, due: null, size: null, note: '',
    raw: '', done: false, doneAt: null, created: t, updated: t,
    sorted: 'rules', pending: null, origin: deviceId, ...p,
  };
}

function commit() {
  writeJSON(LS.data, data);
  dirty = true;
  render();
  scheduleSync();
}

function update(id, patch, manual = false) {
  const it = data.items[id];
  if (!it) return;
  data.items[id] = { ...it, ...patch, ...(manual ? { sorted: 'manual', pending: null } : {}), updated: now() };
  commit();
}

/* ---------- today list: plain entries you write yourself, no AI ---------- */

const liveToday = () => Object.values(data.today)
  .filter(e => !e.deleted && e.day === todayStr())
  .sort((a, b) => a.order - b.order || a.created - b.created);

function addToday(text, ref = null) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return;
  let order = Math.max(-1, ...liveToday().map(e => e.order)) + 1;
  const t = now();
  for (const line of lines) {
    const e = { id: uid(), text: line, done: false, doneAt: null, order: order++, day: todayStr(), ref, created: t, updated: t };
    data.today[e.id] = e;
    freshToday.add(e.id);
  }
  commit();
}

function updateToday(id, patch) {
  const e = data.today[id];
  if (!e) return;
  data.today[id] = { ...e, ...patch, updated: now() };
  commit();
}

function toggleToday(id) {
  const e = data.today[id];
  if (!e) return;
  haptic();
  const done = !e.done;
  const t = now();
  data.today[id] = { ...e, done, doneAt: done ? t : null, updated: t };
  // an entry added from the inbox completes that item too
  const it = e.ref && data.items[e.ref];
  if (it && !it.deleted && it.done !== done) data.items[e.ref] = { ...it, done, doneAt: done ? t : null, updated: t };
  commit();
}

function deleteToday(id) {
  updateToday(id, { deleted: true });
  toast('Removed from today', () => updateToday(id, { deleted: false }));
}

// unfinished entries from earlier days carry over; finished ones stay behind (the nightly job archives them)
function rollover() {
  const t = todayStr();
  let moved = false;
  for (const e of Object.values(data.today)) {
    if (!e.deleted && !e.done && e.day < t) {
      data.today[e.id] = { ...e, day: t, rolled: (e.rolled || 0) + 1, updated: now() };
      moved = true;
    }
  }
  if (moved) commit();
}

const briefDismissed = () => { try { return localStorage.getItem(LS.brief); } catch { return null; } };

/* ---------- rule-based sorting (instant, offline) ---------- */

const RX = {
  idea: /^(idea|maybe|someday|what if)\b|\bidea:/i,
  look: /\b(look into|research|check out|explore|learn (about|how)|find out|investigate|compare|figure out)\b/i,
  get:  /\b(buy|order|pick up|grab|purchase|restock|get (a|an|some|more|new))\b/i,
  read: /\b(read|watch|listen to|podcast|article|video|book|movie|film|show|episode|documentary)\b/i,
  url:  /https?:\/\/[^\s<>"']+/i,
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseDue(text) {
  const s = text.toLowerCase();
  const d = new Date();
  if (/\b(today|tonight)\b/.test(s)) return ymd(d);
  if (/\b(tomorrow|tmrw|tmr)\b/.test(s)) return ymd(addDays(d, 1));
  if (/\bnext week\b/.test(s)) return ymd(addDays(d, ((8 - d.getDay()) % 7) || 7));
  if (/\b(this )?weekend\b/.test(s)) return ymd(addDays(d, d.getDay() === 6 ? 0 : (6 - d.getDay())));
  const inN = s.match(/\bin (\d{1,2}) days?\b/);
  if (inN) return ymd(addDays(d, +inN[1]));
  const wd = s.match(/\b(by|on|this|next|due)\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/)
    || s.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const name = (wd[2] || wd[1]).slice(0, 3);
    const idx = DAYS.findIndex(x => x.startsWith(name));
    let diff = (idx - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return ymd(addDays(d, diff));
  }
  return null;
}

function ruleSort(line) {
  const tags = [...line.matchAll(/(^|\s)#([\w-]+)/g)].map(m => m[2].toLowerCase());
  let title = line.replace(/(^|\s)#[\w-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const url = (title.match(RX.url) || [])[0] || '';

  let kind = 'do';
  if (RX.idea.test(title)) kind = 'idea';
  else if (RX.look.test(title)) kind = 'look';
  else if (RX.get.test(title)) kind = 'get';
  else if (RX.read.test(title) || url) kind = 'read';

  title = title.replace(/^idea:\s*/i, '');
  if (url) {
    title = title.replace(url, '').trim();
    if (!title) { try { const u = new URL(url); title = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); } catch { title = url; } }
  }
  return { title, kind, tags, due: parseDue(line), note: url };
}

function capture(text) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return;
  const batch = aiReady() ? uid() : null;
  for (const line of lines) {
    const it = makeItem({ ...ruleSort(line), raw: text, pending: batch });
    data.items[it.id] = it;
    fresh.add(it.id);
  }
  if (view === 'done') setView('all');
  commit();
  processQueue();
}

/* ---------- AI sorting ---------- */

// pick the provider from settings; both return cleaned items
async function aiSort(c, raw) {
  if (c.provider === 'gemini') return gemini(c.aiModel || (await listModels(c.aiKey))[0], c.aiKey, raw);
  return claude(c.claudeKey, raw);
}

/* Claude (Haiku 5.5): the SDK loads from a CDN on first use, so there's still no build step */

const CLAUDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'kind', 'due', 'group', 'tags', 'size', 'note'],
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: Object.keys(KINDS) },
          due: { type: ['string', 'null'] },
          group: { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string' } },
          size: { type: 'string', enum: ['quick', 'chunk'] },
          note: { type: 'string' },
        },
      },
    },
  },
};

let sdkPromise = null;
const loadClaudeSdk = () => (sdkPromise ||= import(CLAUDE_SDK)
  .then(m => m.default || m.Anthropic)
  .catch(e => { sdkPromise = null; throw e; }));

function aiError(msg, status, retry) {
  const e = new Error(msg);
  e.status = status;
  e.retry = retry;
  return e;
}

async function claude(key, raw) {
  let Anthropic;
  try { Anthropic = await loadClaudeSdk(); }
  catch { throw aiError('couldn’t load the Claude SDK', undefined, true); }

  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 30000 });
  let res;
  try {
    res = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: buildPrompt(),
      messages: [{ role: 'user', content: raw }],
      // sorting is simple: low effort keeps it fast and cheap
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CLAUDE_SCHEMA } },
    });
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionError) throw aiError('Claude unreachable', undefined, true);
    if (e instanceof Anthropic.AuthenticationError) throw aiError('Claude key rejected', 401, false);
    if (e instanceof Anthropic.PermissionDeniedError) throw aiError(`Claude: ${e.message}`, 403, false);
    if (e instanceof Anthropic.RateLimitError) throw aiError('Claude rate limited', 429, true);
    if (e instanceof Anthropic.APIError) throw aiError(`Claude ${e.status}: ${e.message}`, e.status, (e.status ?? 500) >= 500);
    throw e;
  }

  if (res.stop_reason === 'refusal') throw aiError('Claude declined this one', undefined, false);
  if (res.stop_reason === 'max_tokens') throw aiError('capture too long to sort', undefined, false);
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return (JSON.parse(text).items || []).map(cleanAiItem).filter(i => i.title);
}

/* Gemini */

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          kind: { type: 'STRING', enum: Object.keys(KINDS) },
          due: { type: 'STRING', nullable: true },
          group: { type: 'STRING', nullable: true },
          tags: { type: 'ARRAY', items: { type: 'STRING' } },
          size: { type: 'STRING', enum: ['quick', 'chunk'] },
          note: { type: 'STRING' },
        },
        required: ['title', 'kind', 'tags', 'size', 'note'],
      },
    },
  },
  required: ['items'],
};

function buildPrompt() {
  const d = new Date();
  const groups = [...new Set(live().filter(i => !i.done && i.group).map(i => i.group))].slice(0, 40);
  const examples = data.examples.slice(-12);
  return `You sort captures for a personal to-do app. The user throws in quick, messy notes; turn them into clean items.

Today is ${DAYS[d.getDay()]}, ${ymd(d)}.

Rules:
- Split the capture into separate items, one per distinct thing. Never invent items.
- title: short and clean, in the user's own words and language. Drop filler like "need to" or "remember to", date phrases and #tags. No trailing period.
- kind: "do" = a task, errand or chore; "look" = something to research, explore, compare or learn about; "get" = something to buy or acquire; "read" = an article, video, book, show, podcast or link to consume; "idea" = an idea, wish or someday-maybe with no commitment.
- due: YYYY-MM-DD only when a date or deadline is stated or clearly implied ("by friday", "tomorrow"; "next week" means next Monday). Otherwise null.
- group: a short project or theme name (like "Japan trip" or "Apartment") only when the item clearly belongs to a larger effort. Reuse an existing group name exactly when one fits. Otherwise null. Don't make a group for a one-off errand.
- tags: 0-3 short lowercase tags. Keep any #tags the user wrote.
- size: "quick" if it takes under about 10 minutes, otherwise "chunk".
- note: anything useful from the capture that isn't in the title, such as URLs or details. Otherwise "".

Existing groups: ${groups.length ? groups.map(g => JSON.stringify(g)).join(', ') : 'none yet'}
${examples.length ? `\nThe user has corrected these before. Follow their preferences:\n${examples.map(e => `- ${JSON.stringify(e.text)} -> ${e.kind}`).join('\n')}\n` : ''}
Respond only with JSON: {"items":[{"title","kind","due","group","tags","size","note"}]}`;
}

function httpError(service, res, body) {
  const e = new Error(`${service} ${res.status}${body ? ': ' + body : ''}`);
  e.status = res.status;
  e.retry = res.status === 429 || res.status >= 500;
  return e;
}

async function listModels(key) {
  const res = await fetch(`${GEM}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw httpError('Gemini', res, await errText(res));
  const j = await res.json();
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini/.test(n) && !/(tts|image|audio|live|embedding|vision|robotics|computer|learnlm)/.test(n))
    .sort((a, b) => rankModel(b) - rankModel(a));
}

// prefer stable, newer "flash" models: fast, cheap and generous on the free tier
function rankModel(n) {
  let s = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  if (/flash/.test(n)) s += 10;
  if (/lite/.test(n)) s -= 3;
  if (/pro/.test(n)) s -= 2;
  if (/preview|exp/.test(n)) s -= 5;
  if (/-\d{3}$/.test(n)) s -= 0.5;
  return s;
}

async function errText(res) {
  try { const j = await res.json(); return j.error?.message || ''; } catch { return ''; }
}

async function gemini(model, key, raw, withSchema = true) {
  const body = {
    systemInstruction: { parts: [{ text: buildPrompt() }] },
    contents: [{ role: 'user', parts: [{ text: raw }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, ...(withSchema ? { responseSchema: SCHEMA } : {}) },
  };
  const res = await fetch(`${GEM}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (res.status === 400 && withSchema) return gemini(model, key, raw, false);
  if (!res.ok) throw httpError('Gemini', res, await errText(res));
  const j = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  return (json.items || []).map(cleanAiItem).filter(i => i.title);
}

function cleanAiItem(o) {
  return {
    title: String(o.title || '').trim().slice(0, 200),
    kind: KINDS[o.kind] ? o.kind : 'do',
    due: /^\d{4}-\d{2}-\d{2}$/.test(o.due || '') ? o.due : null,
    group: String(o.group || '').trim() || null,
    tags: Array.isArray(o.tags) ? o.tags.map(t => String(t).toLowerCase().replace(/^#/, '').trim()).filter(Boolean).slice(0, 4) : [],
    size: o.size === 'quick' || o.size === 'chunk' ? o.size : null,
    note: String(o.note || '').trim(),
  };
}

async function resolveModel(key) {
  if (cfg.aiModel) return cfg.aiModel;
  const models = await listModels(key);
  if (!models.length) throw new Error('No Gemini models available for this key');
  cfg.aiModel = models[0];
  saveCfg();
  return cfg.aiModel;
}

let aiBusy = false;
async function processQueue() {
  if (aiBusy || !aiReady() || !navigator.onLine) return;
  const batches = {};
  for (const it of live()) {
    if (it.pending && it.origin === deviceId) (batches[it.pending] ||= []).push(it);
  }
  const ids = Object.keys(batches);
  if (!ids.length) return;

  aiBusy = true;
  setAiStatus('sorting…');
  try {
    for (const b of ids) {
      const olds = batches[b].sort((x, y) => x.created - y.created);
      let out;
      try {
        if (cfg.provider === 'gemini') await resolveModel(cfg.aiKey);
        out = await aiSort(cfg, olds[0].raw);
      } catch (e) {
        if (e.retry || e.status === 401 || e.status === 403 || !navigator.onLine || e instanceof TypeError) {
          setAiStatus(e.status === 429 ? 'rate limited · will retry' : `AI unavailable · ${e.message}`, true);
          return;
        }
        // unusable response: keep the rule-sorted version
        clearPending(b);
        setAiStatus(`AI skipped one capture · ${e.message}`, true);
        continue;
      }

      // re-read: the user may have touched these while we waited
      const cur = olds.map(o => data.items[o.id]).filter(Boolean);
      if (!out.length || cur.some(c => c.sorted === 'manual' || c.deleted || c.done)) { clearPending(b); continue; }

      const t = now();
      out.forEach((o, i) => {
        const base = cur[i];
        const it = base
          ? { ...base, ...o, note: o.note || base.note, pending: null, sorted: 'ai', updated: t }
          : makeItem({ ...o, raw: cur[0].raw, created: cur[0].created, sorted: 'ai' });
        data.items[it.id] = it;
        if (!base) fresh.add(it.id);
      });
      cur.slice(out.length).forEach(c => { data.items[c.id] = { ...c, deleted: true, pending: null, updated: t }; });
      commit();
    }
    setAiStatus('');
  } finally {
    aiBusy = false;
  }
}

function clearPending(batch) {
  for (const it of live()) if (it.pending === batch) data.items[it.id] = { ...it, pending: null, updated: now() };
  commit();
}

function setAiStatus(msg, warn = false) {
  aiStatus = msg ? { msg, warn } : '';
  renderHint();
}

/* ---------- sync (GitHub Gist) ---------- */

let dirty = false, syncing = false, syncAgain = false, syncTimer = null;

function scheduleSync(ms = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${cfg.ghToken}`,
      Accept: 'application/vnd.github+json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const hint = res.status === 401 ? 'token rejected' : res.status === 404 ? 'gist not found (check ID and token scope)' : '';
    throw httpError('GitHub', res, hint);
  }
  return res.json();
}

async function pullGist() {
  const g = await gh(`/gists/${cfg.gistId}`);
  const f = g.files?.[FILE];
  if (!f) return null;
  const content = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return JSON.parse(content);
}

// per-entry merge: the most recently edited version of each entry wins
function mergeMap(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, it] of Object.entries(b)) {
    const cur = out[id];
    if (!cur || (it.updated || 0) > (cur.updated || 0)) out[id] = it;
  }
  const cutoff = now() - TOMBSTONE_DAYS * DAY_MS;
  for (const [id, it] of Object.entries(out)) if (it.deleted && it.updated < cutoff) delete out[id];
  return out;
}

const newer = (x, y) => ((y?.updated || 0) > (x?.updated || 0) ? y : x) || null;

function merge(a, b) {
  const seen = new Set();
  const examples = [...(a.examples || []), ...(b.examples || [])]
    .sort((x, y) => x.at - y.at)
    .filter(e => { const k = e.text + '→' + e.kind; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(-20);
  // spread first so fields from other app versions (or the nightly job) survive a sync
  return {
    ...b, ...a, v: 1,
    items: mergeMap(a.items, b.items),
    today: mergeMap(a.today, b.today),
    examples,
    briefing: newer(a.briefing, b.briefing),
  };
}

function mapDiffers(from = {}, to = {}) {
  for (const [id, it] of Object.entries(to)) if (from[id]?.updated !== it.updated) return true;
  return Object.keys(from).length !== Object.keys(to).length;
}

function differs(from, to) {
  return mapDiffers(from.items, to.items)
    || mapDiffers(from.today, to.today)
    || (from.examples || []).length !== to.examples.length
    || (from.briefing?.updated || 0) !== (to.briefing?.updated || 0);
}

const serialize = d => JSON.stringify(d);

async function sync() {
  if (!cfg.ghToken) return setSync('local', 'Add a GitHub token in settings to sync');
  if (!navigator.onLine) return setSync('offline');
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSync('syncing');
  try {
    if (!cfg.gistId) {
      // reuse an existing Canopy gist (e.g. made by your other device) before creating one
      const existing = (await gh('/gists?per_page=100')).find(g => g.files?.[FILE]);
      if (existing) { cfg.gistId = existing.id; saveCfg(); }
    }
    if (!cfg.gistId) {
      const g = await gh('/gists', {
        method: 'POST',
        body: JSON.stringify({ description: 'Canopy · todo data', public: false, files: { [FILE]: { content: serialize(data) } } }),
      });
      cfg.gistId = g.id;
      saveCfg();
      dirty = false;
      toast('Created your private sync Gist');
    } else {
      const remote = await pullGist();
      const wasDirty = dirty;
      dirty = false;
      const merged = remote ? merge(data, remote) : data;
      const gotNew = remote && differs(data, merged);
      const needPush = !remote || wasDirty || differs(remote, merged);
      data = merged;
      writeJSON(LS.data, data);
      if (gotNew) { rollover(); render(); }
      if (needPush) {
        await gh(`/gists/${cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: serialize(data) } } }) });
      }
    }
    setSync('synced', `Last synced ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    dirty = true;
    setSync('error', e.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

function setSync(state, title = '') {
  const el = $('#sync');
  el.dataset.state = state;
  el.title = title || 'Sync now';
  el.querySelector('span').textContent = { local: 'local only', syncing: 'syncing', synced: 'synced', offline: 'offline', error: 'sync error' }[state];
}

/* ---------- rendering ---------- */

function fmtDue(due) {
  const diff = Math.round((parseYmd(due) - parseYmd(todayStr())) / DAY_MS);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return parseYmd(due).toLocaleDateString(undefined, { weekday: 'short' }).toLowerCase();
  return parseYmd(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
}

const sortOpen = (a, b) =>
  (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0) || b.created - a.created;

function card(it, showGroup) {
  const k = KINDS[it.kind] || KINDS.do;
  const t = todayStr();
  const meta = [`<span class="kind">${k.glyph} ${esc(k.label.toLowerCase())}</span>`];
  if (it.due && !it.done) meta.push(`<span class="due ${it.due < t ? 'over' : it.due === t ? 'now' : ''}">${it.due < t ? 'overdue · ' : ''}${esc(fmtDue(it.due))}</span>`);
  if (it.done && it.doneAt) meta.push(`<span>done ${esc(new Date(it.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase())}</span>`);
  if (showGroup && it.group) meta.push(`<span>⌁ ${esc(it.group)}</span>`);
  if (it.size === 'quick' && !it.done) meta.push('<span>quick</span>');
  for (const tag of it.tags || []) meta.push(`<span>#${esc(tag)}</span>`);
  const url = (it.note || '').match(RX.url)?.[0];
  if (url) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    meta.push(`<a href="${esc(url)}" target="_blank" rel="noopener" data-act="link">↗ ${esc(host)}</a>`);
  } else if (it.note) meta.push('<span title="Has a note">¶ note</span>');

  const cls = ['item'];
  if (it.done) cls.push('done');
  if (it.pending && aiReady()) cls.push('pending');
  if (!it.done && now() - it.updated > STALE_DAYS * DAY_MS) cls.push('stale');
  if (fresh.has(it.id)) cls.push('fresh');
  if (openId === it.id) cls.push('open');

  return `<li class="swipe-row" data-id="${esc(it.id)}" style="--kc:var(--k-${esc(it.kind)})">
    <div class="swipe-bg" aria-hidden="true"><span class="sb-done">${it.done ? '↺ not done' : '✓ done'}</span><span class="sb-del">delete ✕</span></div>
    <div class="${cls.join(' ')}">
      <button class="check" data-act="toggle" aria-label="${it.done ? 'Mark not done' : 'Mark done'}"></button>
      <div class="body" data-act="open">
        <div class="title">${esc(it.title)}</div>
        <div class="meta">${meta.join('')}</div>
      </div>
      ${openId === it.id ? editor(it) : ''}
    </div>
  </li>`;
}

function editor(it) {
  const kinds = Object.entries(KINDS).map(([key, k]) =>
    `<button type="button" data-act="kind" data-kind="${key}" class="${key === it.kind ? 'on' : ''}" style="--kc:var(--k-${key})">${k.glyph} ${esc(k.label)}</button>`).join('');
  const sortedBy = { ai: 'sorted by AI', rules: 'sorted by rules', manual: 'edited by you' }[it.sorted] || '';
  return `<div class="editor">
    <input data-field="title" value="${esc(it.title)}" aria-label="Title">
    <div class="kinds">${kinds}</div>
    <div class="row">
      <label>due<input type="date" data-field="due" value="${esc(it.due || '')}"></label>
      <label>group<input data-field="group" list="groups" value="${esc(it.group || '')}" placeholder="none"></label>
    </div>
    <label>tags<input data-field="tags" value="${esc((it.tags || []).join(', '))}" placeholder="comma separated"></label>
    <label>notes<textarea data-field="note" placeholder="details, links, findings…">${esc(it.note)}</textarea></label>
    <div class="ed-foot">
      <span>${esc(new Date(it.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase())} · ${esc(sortedBy)}</span>
      <span class="ed-actions">
        <button type="button" class="ed-today" data-act="to-today">☀ add to today</button>
        <button type="button" class="danger" data-act="delete">delete</button>
      </span>
    </div>
  </div>`;
}

const section = (name, items, showGroup = false) => items.length
  ? `${name ? `<div class="section">${esc(name)} <span class="n">${items.length}</span></div>` : ''}<ul class="items">${items.map(i => card(i, showGroup)).join('')}</ul>`
  : '';

function emptyState(title, sub) {
  return `<div class="empty"><b>${esc(title)}</b>${esc(sub)}</div>`;
}

const DOTS = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';

function todayRow(e) {
  const text = editTodayId === e.id
    ? `<input class="t-edit" data-tid="${esc(e.id)}" value="${esc(e.text)}" enterkeyhint="done" aria-label="Edit">`
    : `<div class="t-text" data-tact="edit">${esc(e.text)}${e.rolled ? `<span class="t-rolled" title="Carried over from an earlier day">↻</span>` : ''}</div>`;
  return `<li class="swipe-row t-wrap" data-id="${esc(e.id)}" data-list="today">
    <div class="swipe-bg" aria-hidden="true"><span class="sb-done">${e.done ? '↺ undo' : '✓ done'}</span><span class="sb-del">remove ✕</span></div>
    <div class="t-row ${e.done ? 'done' : ''} ${freshToday.has(e.id) ? 'fresh' : ''}">
      <button class="t-check" data-tact="toggle" aria-label="${e.done ? 'Mark not done' : 'Mark done'}"></button>
      ${text}
      <button class="t-handle" aria-label="Drag to reorder">${DOTS}</button>
    </div>
  </li>`;
}

function todayPanel() {
  const t = todayStr();
  const entries = liveToday();
  const doneN = entries.filter(e => e.done).length;
  const refs = new Set(entries.map(e => e.ref).filter(Boolean));
  const suggest = live().filter(i => !i.done && i.due && i.due <= t && !refs.has(i.id)).sort(sortOpen).slice(0, 5);
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toLowerCase();
  const b = data.briefing;
  const brief = b && b.date === t && b.text && briefDismissed() !== t
    ? `<div class="brief"><span class="brief-mark">✦</span><p>${esc(b.text)}</p><button class="brief-x" data-tact="dismiss-brief" aria-label="Dismiss briefing">✕</button></div>`
    : '';

  return `<section class="today" aria-label="Today">
    <div class="today-head">
      <span class="today-title">Today</span>
      <span class="today-date">${esc(date)}</span>
      ${entries.length ? `<span class="today-count${doneN === entries.length ? ' all' : ''}">${doneN}/${entries.length}</span>` : ''}
    </div>
    ${brief}
    <ul class="t-list">${entries.map(todayRow).join('')}</ul>
    <form class="t-add" id="tAdd" autocomplete="off">
      <span class="t-plus" aria-hidden="true">+</span>
      <input id="tAddInput" placeholder="${entries.length ? 'add another…' : 'what do you want to do today?'}" enterkeyhint="done" aria-label="Add to today">
    </form>
    ${suggest.length ? `<div class="t-suggest"><span class="t-suggest-label">due</span>${suggest.map(i =>
      `<button type="button" class="t-chip" data-tact="suggest" data-ref="${esc(i.id)}">+ ${esc(i.title)}</button>`).join('')}</div>` : ''}
  </section>`;
}

function renderList() {
  const all = live();
  const open = all.filter(i => !i.done);
  const t = todayStr();
  let html = '';

  // keep whatever is being typed in the today list across re-renders (e.g. a sync landing)
  const active = document.activeElement;
  const keep = active?.id === 'tAddInput' ? { sel: '#tAddInput', value: active.value }
    : active?.classList?.contains('t-edit') ? { sel: '.t-edit', value: active.value } : null;

  if (view === 'done') {
    const done = all.filter(i => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 150);
    html = done.length ? section('', done, true) : emptyState('Nothing finished yet', 'checked-off things settle here');
  } else if (view === 'today') {
    const quick = open.filter(i => !(i.due && i.due <= t) && i.size === 'quick' && i.kind !== 'idea').sort(sortOpen).slice(0, 8);
    html = todayPanel() + section('Quick wins', quick, true);
  } else {
    const items = view === 'all' ? open : open.filter(i => i.kind === view);
    const loose = items.filter(i => !i.group).sort(sortOpen);
    const groups = new Map();
    for (const i of items.filter(i => i.group)) {
      if (!groups.has(i.group)) groups.set(i.group, []);
      groups.get(i.group).push(i);
    }
    const ordered = [...groups.entries()]
      .sort((a, b) => Math.max(...b[1].map(i => i.updated)) - Math.max(...a[1].map(i => i.updated)));
    html = section(ordered.length || view === 'all' ? 'Inbox' : '', loose) + ordered.map(([g, arr]) => section(g, arr.sort(sortOpen))).join('');
    if (!html) html = view === 'all'
      ? emptyState('Inbox is empty', 'throw something in above')
      : emptyState(`No ${KINDS[view].label.toLowerCase()} items`, 'they show up here once you add some');
    if (view === 'all') html = todayPanel() + html;
  }

  $('#list').innerHTML = html;
  if (keep) {
    const el = $(keep.sel);
    if (el) { el.value = keep.value; el.focus(); }
  }
  if (fresh.size || freshToday.size) setTimeout(() => { fresh.clear(); freshToday.clear(); }, 700);
}

function renderChips() {
  const all = live();
  const open = all.filter(i => !i.done);
  const counts = {
    all: open.length,
    today: liveToday().filter(e => !e.done).length,
    done: all.filter(i => i.done).length,
  };
  for (const k of Object.keys(KINDS)) counts[k] = open.filter(i => i.kind === k).length;

  const defs = [['all', 'All'], ['today', 'Today'], ...Object.entries(KINDS).map(([k, v]) => [k, v.short, v.glyph]), ['done', 'Done']];
  $('#chips').innerHTML = defs.map(([key, label, glyph]) =>
    `<button class="chip ${view === key ? 'on' : ''} ${counts[key] ? '' : 'zero'}" data-view="${key}" ${glyph ? `style="--kc:var(--k-${key})"` : ''}>
      ${glyph ? `<span class="g">${glyph}</span>` : ''}${esc(label)}<span class="n">${counts[key]}</span>
    </button>`).join('');

  const groups = [...new Set(open.filter(i => i.group).map(i => i.group))];
  $('#groups').innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');
}

const isTouch = matchMedia('(pointer: coarse)').matches;

function renderHint() {
  // on phones, only show the line when there's something to say
  if (isTouch) {
    $('#hint').innerHTML = aiStatus ? `<span class="${aiStatus.warn ? 'warn' : ''}">${esc(aiStatus.msg)}</span>` : '';
    return;
  }
  const base = 'enter to add · shift+enter for new line · #tags · “tomorrow”, “by fri”';
  let ai;
  if (aiStatus) ai = `<span class="${aiStatus.warn ? 'warn' : ''}">${esc(aiStatus.msg)}</span>`;
  else if (aiReady()) ai = `<b>✦ AI sorting on</b> · ${esc(cfg.provider === 'gemini' ? (cfg.aiModel || 'gemini') : 'claude haiku 5.5')}`;
  else ai = 'rules sorting · add an AI key in settings';
  $('#hint').innerHTML = `${ai}<br>${base}`;
}

function render() {
  renderChips();
  renderList();
  renderHint();
}

function setView(v) {
  view = v;
  openId = null;
  try { localStorage.setItem(LS.view, v); } catch {}
  render();
}

/* ---------- theme (per device, not synced) ---------- */

const systemLight = matchMedia('(prefers-color-scheme: light)');
const getTheme = () => { try { return localStorage.getItem(LS.theme) || 'system'; } catch { return 'system'; } };

function applyTheme() {
  const pref = getTheme();
  const theme = pref === 'system' ? (systemLight.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]').content = theme === 'light' ? '#f2f5ef' : '#0a100e';
  document.querySelectorAll('[data-theme-choice]').forEach(b => {
    const on = b.dataset.themeChoice === pref;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
}

function setTheme(pref) {
  try { localStorage.setItem(LS.theme, pref); } catch {}
  applyTheme();
}

systemLight.addEventListener('change', applyTheme);
$('#themePicker').addEventListener('click', e => {
  const b = e.target.closest('[data-theme-choice]');
  if (b) setTheme(b.dataset.themeChoice);
});

/* ---------- haptics ---------- */

// iOS Safari has no vibrate API, but toggling a native switch gives a light tap (iOS 18+)
const hapticLabel = (() => {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('switch', '');
  box.tabIndex = -1;
  label.appendChild(box);
  document.body.appendChild(label);
  return label;
})();

function haptic() {
  if (navigator.vibrate) { navigator.vibrate(8); return; }
  if (isTouch) hapticLabel.click();
}

/* ---------- toast ---------- */

let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">undo</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { undo(); el.classList.remove('show'); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

/* ---------- events: capture ---------- */

const input = $('#captureInput');
const grow = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
input.addEventListener('input', grow);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#capture').requestSubmit(); }
});
$('#capture').addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  capture(text);
  input.value = '';
  grow();
});

/* ---------- events: list ---------- */

$('#chips').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

function completeItem(id, row) {
  const it = data.items[id];
  if (!it) return;
  haptic();
  if (!it.done) {
    row?.classList.add('leaving');
    setTimeout(() => update(id, { done: true, doneAt: now() }), row ? 420 : 0);
    toast('Done', () => update(id, { done: false, doneAt: null }));
  } else {
    update(id, { done: false, doneAt: null });
  }
}

function deleteItem(id) {
  if (openId === id) openId = null;
  update(id, { deleted: true, pending: null });
  toast('Deleted', () => update(id, { deleted: false }));
}

let suppressClick = false;

$('#list').addEventListener('click', e => {
  if (suppressClick) return;
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const li = el.closest('[data-id]');
  const id = li?.dataset.id;
  const it = id && data.items[id];
  if (!it) return;

  switch (el.dataset.act) {
    case 'link':
      return; // let the browser open it
    case 'open':
      openId = openId === id ? null : id;
      renderList();
      return;
    case 'toggle':
      completeItem(id, li);
      return;
    case 'kind': {
      const kind = el.dataset.kind;
      if (kind === it.kind) return;
      if (it.sorted !== 'manual') {
        // remember the correction so the AI learns your preferences
        data.examples = [...data.examples.filter(x => x.text !== it.title), { text: it.title, kind, at: now() }].slice(-20);
      }
      update(id, { kind }, true);
      return;
    }
    case 'delete':
      deleteItem(id);
      return;
    case 'to-today':
      addToday(it.title, it.id);
      toast('Added to today');
      return;
  }
});

/* ---------- events: today list ---------- */

$('#list').addEventListener('click', e => {
  if (suppressClick) return;
  const el = e.target.closest('[data-tact]');
  if (!el) return;
  const id = el.closest('[data-list=today]')?.dataset.id;

  switch (el.dataset.tact) {
    case 'toggle':
      toggleToday(id);
      return;
    case 'edit':
      editTodayId = id;
      renderList();
      { const inp = $('.t-edit'); inp?.focus(); inp?.setSelectionRange(inp.value.length, inp.value.length); }
      return;
    case 'suggest': {
      const it = data.items[el.dataset.ref];
      if (it) addToday(it.title, it.id);
      return;
    }
    case 'dismiss-brief':
      try { localStorage.setItem(LS.brief, todayStr()); } catch {}
      renderList();
      return;
  }
});

$('#list').addEventListener('submit', e => {
  if (e.target.id !== 'tAdd') return;
  e.preventDefault();
  const inp = $('#tAddInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  addToday(text);
  $('#tAddInput')?.focus(); // keep the keyboard up to add the next one
});

// pasting several lines adds one entry per line
$('#list').addEventListener('paste', e => {
  if (e.target.id !== 'tAddInput') return;
  const text = e.clipboardData?.getData('text') || '';
  if (!text.includes('\n')) return;
  e.preventDefault();
  addToday(text);
  $('#tAddInput')?.focus();
});

function finishTodayEdit(inp, save) {
  const id = inp.dataset.tid;
  if (editTodayId !== id) return; // already finished (removing a focused input can fire focusout again)
  editTodayId = null;
  const text = inp.value.trim();
  const e = data.today[id];
  if (save && e && text && text !== e.text) updateToday(id, { text });
  else if (save && e && !text) deleteToday(id);
  else renderList();
}

$('#list').addEventListener('keydown', e => {
  if (!e.target.classList.contains('t-edit')) return;
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.dataset.cancel = '1'; e.target.blur(); }
});
$('#list').addEventListener('focusout', e => {
  if (e.target.classList.contains('t-edit')) finishTodayEdit(e.target, !e.target.dataset.cancel);
});

/* drag the ⋮⋮ handle to reorder (mouse or touch) */

let reorder = null;

$('#list').addEventListener('pointerdown', e => {
  const handle = e.target.closest('.t-handle');
  if (!handle) return;
  e.preventDefault();
  const row = handle.closest('.t-wrap');
  reorder = { row, list: row.parentElement, id: e.pointerId, startY: e.clientY };
  try { handle.setPointerCapture(e.pointerId); } catch {}
  row.classList.add('lifted');
  haptic();
});

$('#list').addEventListener('pointermove', e => {
  if (!reorder || e.pointerId !== reorder.id) return;
  e.preventDefault();
  const { row, list } = reorder;
  const center = row.offsetTop + row.offsetHeight / 2 + (e.clientY - reorder.startY);
  const prev = row.previousElementSibling;
  const next = row.nextElementSibling;
  // swap with a neighbour once the dragged row passes its middle
  if (next && center > next.offsetTop + next.offsetHeight / 2) {
    const before = row.offsetTop;
    list.insertBefore(next, row);
    reorder.startY += row.offsetTop - before;
  } else if (prev && center < prev.offsetTop + prev.offsetHeight / 2) {
    const before = row.offsetTop;
    list.insertBefore(row, prev);
    reorder.startY += row.offsetTop - before;
  }
  row.style.transform = `translateY(${e.clientY - reorder.startY}px)`;
});

function endReorder(e) {
  if (!reorder || e.pointerId !== reorder.id) return;
  const { row, list } = reorder;
  reorder = null;
  row.style.transform = '';
  row.classList.remove('lifted');
  let changed = false;
  [...list.children].forEach((li, i) => {
    const entry = data.today[li.dataset.id];
    if (entry && entry.order !== i) { data.today[li.dataset.id] = { ...entry, order: i, updated: now() }; changed = true; }
  });
  if (changed) commit();
}
$('#list').addEventListener('pointerup', endReorder);
$('#list').addEventListener('pointercancel', endReorder);

/* ---------- swipe gestures (touch): right = done, left = delete ---------- */

const SWIPE_AT = 90;
let drag = null;

const settle = (card, row) => {
  card.style.transition = 'transform .25s cubic-bezier(.2, .8, .2, 1)';
  card.style.transform = '';
  delete row.dataset.swipe;
  row.classList.remove('armed', 'swiping');
};

$('#list').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' || drag) return;
  const card = e.target.closest('.item, .t-row');
  const row = card?.closest('.swipe-row');
  if (!row || row.dataset.id === openId || e.target.closest('input, textarea, a, .t-handle')) return;
  drag = { row, card, id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false, armed: false };
});

$('#list').addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
    if (Math.abs(dx) < 10) return;
    drag.active = true;
    try { drag.card.setPointerCapture(e.pointerId); } catch {}
    drag.row.classList.add('swiping');
    drag.card.style.transition = 'none';
  }
  drag.dx = dx;
  // follow the finger, then resist past the trigger point
  const mag = Math.abs(dx);
  const eased = mag <= 140 ? mag : 140 + (mag - 140) * 0.3;
  drag.card.style.transform = `translateX(${Math.sign(dx) * eased}px)`;
  drag.row.dataset.swipe = dx > 0 ? 'right' : 'left';
  const armed = mag > SWIPE_AT;
  if (armed !== drag.armed) {
    drag.armed = armed;
    drag.row.classList.toggle('armed', armed);
    if (armed) haptic();
  }
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);

  if (!(d.armed && e.type === 'pointerup')) { settle(d.card, d.row); return; }
  const id = d.row.dataset.id;
  d.card.style.transition = 'transform .22s ease-in';
  d.card.style.transform = `translateX(${d.dx > 0 ? '' : '-'}110%)`;
  setTimeout(() => {
    if (d.row.dataset.list === 'today') {
      if (d.dx > 0) toggleToday(id); else deleteToday(id);
      return;
    }
    if (d.dx > 0) {
      const it = data.items[id];
      if (it && !it.done) { update(id, { done: true, doneAt: now() }); toast('Done', () => update(id, { done: false, doneAt: null })); }
      else update(id, { done: false, doneAt: null });
    } else {
      deleteItem(id);
    }
  }, 200);
}
$('#list').addEventListener('pointerup', endDrag);
$('#list').addEventListener('pointercancel', endDrag);

$('#list').addEventListener('change', e => {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const id = el.closest('[data-id]')?.dataset.id;
  if (!id) return;
  const v = el.value.trim();
  const patch = {
    title: () => (v ? { title: v } : null),
    due: () => ({ due: v || null }),
    group: () => ({ group: v || null }),
    tags: () => ({ tags: v.split(',').map(s => s.trim().toLowerCase().replace(/^#/, '')).filter(Boolean) }),
    note: () => ({ note: el.value }),
  }[el.dataset.field]?.();
  if (patch) update(id, patch, true);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openId && !$('#settings').open) { openId = null; renderList(); }
  if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); input.focus(); }
});

/* ---------- header ---------- */

const scroller = $('#scroller');
scroller.addEventListener('scroll', () => {
  $('#appbar').classList.toggle('scrolled', scroller.scrollTop > 4);
}, { passive: true });
// the page doesn't scroll, so iOS's tap-the-status-bar shortcut can't reach the list; the logo does it instead
$('#brand').addEventListener('click', () => scroller.scrollTo({ top: 0, behavior: 'smooth' }));

/* ---------- events: sync triggers ---------- */

$('#sync').addEventListener('click', () => { sync(); processQueue(); });
window.addEventListener('online', () => { sync(); processQueue(); });
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { rollover(); sync(); processQueue(); render(); }
});
let lastDay = todayStr();
setInterval(() => {
  if (todayStr() !== lastDay) { lastDay = todayStr(); rollover(); render(); } // midnight while open
  if (document.visibilityState === 'visible') { sync(); processQueue(); }
}, 60000);

/* ---------- settings ---------- */

const dlg = $('#settings');

function fillModelSelect(models, selected) {
  const sel = $('#aiModel');
  const list = models.length ? models : (selected ? [selected] : []);
  sel.innerHTML = `<option value="">auto (best free flash model)</option>` +
    list.map(m => `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

// AI settings as currently entered in the form (not yet saved)
const formAi = () => ({
  provider: $('#provider').value,
  claudeKey: $('#claudeKey').value.trim(),
  aiKey: $('#aiKey').value.trim(),
  aiModel: $('#aiModel').value,
  aiOn: $('#aiOn').checked,
});

function showProviderFields() {
  const gem = $('#provider').value === 'gemini';
  $('#geminiFields').hidden = !gem;
  $('#claudeFields').hidden = gem;
}

function openSettings() {
  $('#ghToken').value = cfg.ghToken;
  $('#gistId').value = cfg.gistId;
  $('#provider').value = cfg.provider;
  $('#claudeKey').value = cfg.claudeKey;
  $('#aiKey').value = cfg.aiKey;
  $('#aiOn').checked = cfg.aiOn;
  showProviderFields();
  $('#setupCode').value = '';
  $('#setupStatus').hidden = true;
  $('#testOut').hidden = true;
  fillModelSelect([], cfg.aiModel);
  dlg.showModal();
}

$('#openSettings').addEventListener('click', openSettings);
$('#provider').addEventListener('change', () => { showProviderFields(); $('#testOut').hidden = true; });
dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));

$('#loadModels').addEventListener('click', async () => {
  const key = $('#aiKey').value.trim();
  const out = $('#testOut');
  if (!key) { out.hidden = false; out.textContent = 'Paste your Gemini API key first.'; return; }
  try {
    const models = await listModels(key);
    fillModelSelect(models, $('#aiModel').value || cfg.aiModel || models[0]);
    out.hidden = false;
    out.textContent = `Found ${models.length} models. Top pick: ${models[0] || 'none'}`;
  } catch (e) {
    out.hidden = false;
    out.textContent = `Couldn't load models: ${e.message}`;
  }
});

$('#testAI').addEventListener('click', async () => {
  const c = formAi();
  const name = c.provider === 'gemini' ? 'Gemini' : 'Claude';
  const out = $('#testOut');
  out.hidden = false;
  if (!providerKey(c)) { out.textContent = `Paste your ${name} API key first.`; return; }
  out.textContent = `asking ${name}…`;
  const sample = 'need to renew passport by friday, look into that rust game engine thing, buy coffee filters, idea: plant shelf for the window';
  const started = performance.now();
  try {
    const items = await aiSort(c, sample);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    out.textContent = `✓ ${name} works · ${secs}s\n\n“${sample}”\n\n` +
      items.map(i => `${KINDS[i.kind].glyph} ${i.title}  [${i.kind}${i.due ? ' · ' + i.due : ''}${i.group ? ' · ' + i.group : ''}]`).join('\n');
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
  }
});

$('#copySetup').addEventListener('click', async () => {
  const ghToken = $('#ghToken').value.trim();
  const code = btoa(JSON.stringify({ ghToken, gistId: $('#gistId').value.trim() || cfg.gistId, ...formAi() }));
  const note = ghToken ? 'Setup code copied' : 'Copied, but it has no GitHub token, so the other device won’t sync';
  try { await navigator.clipboard.writeText(code); toast(note); }
  catch { $('#setupCode').value = code; $('#setupCode').select(); toast('Copy the code from the field'); }
});

function decodeSetup(code) {
  try {
    const c = JSON.parse(atob(code.replace(/\s+/g, '')));
    return c && typeof c === 'object' && ('ghToken' in c || 'claudeKey' in c || 'aiKey' in c) ? c : null;
  } catch { return null; }
}

// fill the form from a pasted setup code and say what it contained
function applySetupCode(code) {
  const status = $('#setupStatus');
  status.hidden = !code;
  if (!code) return true;
  const c = decodeSetup(code);
  if (!c) {
    status.innerHTML = '<span class="bad">✗ That doesn’t look like a setup code. Copy it again from your other device.</span>';
    return false;
  }
  if (c.ghToken) $('#ghToken').value = c.ghToken;
  if (c.gistId) $('#gistId').value = c.gistId;
  if (c.provider) $('#provider').value = c.provider;
  if (c.claudeKey) $('#claudeKey').value = c.claudeKey;
  if (c.aiKey) $('#aiKey').value = c.aiKey;
  if (c.aiModel) fillModelSelect([], c.aiModel);
  if (typeof c.aiOn === 'boolean') $('#aiOn').checked = c.aiOn;
  showProviderFields();

  const mark = (ok, label) => `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${label}</span>`;
  const aiKeyIn = c.provider === 'gemini' ? c.aiKey : c.claudeKey;
  status.innerHTML = [
    mark(!!c.ghToken, c.ghToken ? 'GitHub sync' : 'no GitHub token (set up sync on the other device first)'),
    mark(!!aiKeyIn, aiKeyIn ? `${c.provider === 'gemini' ? 'Gemini' : 'Claude'} key` : 'no AI key'),
  ].join(' · ') + '<br>Now tap <b>save</b>.';
  return true;
}

$('#setupCode').addEventListener('input', e => applySetupCode(e.target.value.trim()));

$('#exportData').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `canopy-${todayStr()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    data = merge(data, incoming);
    commit();
    toast(`Imported ${Object.keys(incoming.items || {}).length} items`);
  } catch { toast('That file isn’t valid Canopy JSON'); }
  e.target.value = '';
});

$('#settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!applySetupCode($('#setupCode').value.trim())) return;
  const next = {
    ghToken: $('#ghToken').value.trim(),
    gistId: ($('#gistId').value.trim().match(/[0-9a-f]{20,}/i) || [''])[0],
    ...formAi(),
  };
  const tokenChanged = next.ghToken !== cfg.ghToken || next.gistId !== cfg.gistId;
  cfg = { ...cfg, ...next };
  saveCfg();
  dlg.close();
  toast(cfg.ghToken ? 'Saved · syncing…' : 'Saved');
  setAiStatus('');
  render();
  if (tokenChanged) dirty = true;
  sync();
  processQueue();
});

/* ---------- boot ---------- */

applyTheme();
rollover();
render();
sync();
processQueue();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
