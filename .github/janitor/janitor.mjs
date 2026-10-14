// Canopy nightly janitor
//
// 1. Carries unfinished Today entries over to the new day
// 2. Moves finished things into archive.json (same Gist) so canopy.json stays small
// 3. Writes a two-sentence morning briefing with Claude Haiku
//
// Usage:
//   node janitor.mjs                              read and update the Gist (GIST_ID, GIST_TOKEN)
//   node janitor.mjs --dry-run                    read the Gist, report what would change, write nothing
//   node janitor.mjs --file data.json [--out o]   work on a local copy instead of the Gist
//
// Env: GIST_ID, GIST_TOKEN, ANTHROPIC_API_KEY (optional; no key = no briefing), TZ_NAME
//
// The repo is public, so Actions logs are too: only counts are ever logged, never item text.

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'canopy.json';
const ARCHIVE = 'archive.json';
const MODEL = 'claude-haiku-5-5';
const TZ = process.env.TZ_NAME || 'Europe/Berlin';
const DAY_MS = 86400000;
const TOMBSTONE_DAYS = 30;
const KEEP_DONE_DAYS = 7; // finished inbox items stay in the app's Done view this long

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const optValue = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const localFile = optValue('--file');
const outFile = optValue('--out') || localFile;

const dayIn = ms => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/* ---------- GitHub Gist ---------- */

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${opts.method || 'GET'} ${path.replace(/[0-9a-f]{20,}/, '<gist>')}`);
  return res.json();
}

async function readGistFile(file) {
  if (!file) return null;
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return JSON.parse(text);
}

async function loadGist() {
  const g = await gh(`/gists/${process.env.GIST_ID}`);
  return { data: await readGistFile(g.files[FILE]), archive: await readGistFile(g.files[ARCHIVE]) };
}

/* ---------- same merge rules as the app ---------- */

function mergeMap(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, it] of Object.entries(b)) {
    if (!out[id] || (it.updated || 0) > (out[id].updated || 0)) out[id] = it;
  }
  return out;
}

const newer = (x, y) => ((y?.updated || 0) > (x?.updated || 0) ? y : x) || null;

function merge(a, b) {
  return { ...b, ...a, items: mergeMap(a.items, b.items), today: mergeMap(a.today, b.today), briefing: newer(a.briefing, b.briefing) };
}

/* ---------- the nightly pass ---------- */

function tidy(data, archive, t = Date.now()) {
  const today = dayIn(t);
  const stats = { rolledOver: 0, archivedItems: 0, archivedToday: 0, purgedTombstones: 0 };
  data.items ||= {};
  data.today ||= {};
  archive.items ||= {};
  archive.today ||= {};
  const tombstone = id => ({ id, deleted: true, archived: true, updated: t });

  for (const e of Object.values(data.today)) {
    if (e.deleted) continue;
    if (!e.done && e.day < today) {
      data.today[e.id] = { ...e, day: today, rolled: (e.rolled || 0) + 1, updated: t };
      stats.rolledOver++;
    } else if (e.done && e.day < today) {
      archive.today[e.id] = { ...e, archivedAt: t };
      data.today[e.id] = tombstone(e.id);
      stats.archivedToday++;
    }
  }

  const keepFrom = dayIn(t - KEEP_DONE_DAYS * DAY_MS);
  for (const it of Object.values(data.items)) {
    if (!it.deleted && it.done && it.doneAt && dayIn(it.doneAt) < keepFrom) {
      archive.items[it.id] = { ...it, archivedAt: t };
      data.items[it.id] = tombstone(it.id);
      stats.archivedItems++;
    }
  }

  // tombstones only need to live long enough for every device to see them
  for (const map of [data.items, data.today]) {
    for (const [id, x] of Object.entries(map)) {
      if (x.deleted && x.updated < t - TOMBSTONE_DAYS * DAY_MS) { delete map[id]; stats.purgedTombstones++; }
    }
  }
  return { today, stats };
}

/* ---------- morning briefing ---------- */

const BRIEFING_PROMPT = `You write the morning briefing at the top of someone's personal to-do app.
Write exactly two short sentences, second person, plain text: no greeting, lists, emoji or quotation marks, under 45 words in total.
Name the one or two things that matter most today: overdue or due-today items, and anything carried over from earlier days. If the day looks light, say so and point at something worth picking up.
Only mention things that appear in the data. Never invent tasks.`;

function briefingInput(data, today, t) {
  const yesterday = dayIn(t - DAY_MS);
  const items = Object.values(data.items).filter(i => !i.deleted);
  const open = items.filter(i => !i.done);
  const list = Object.values(data.today).filter(e => !e.deleted && e.day === today).sort((a, b) => a.order - b.order);
  return {
    date: today,
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(new Date(t)),
    todayList: list.map(e => ({ text: e.text, carriedOverDays: e.rolled || 0 })),
    overdue: open.filter(i => i.due && i.due < today).map(i => ({ title: i.title, due: i.due })),
    dueToday: open.filter(i => i.due === today).map(i => i.title),
    inbox: {
      open: open.length,
      byKind: Object.fromEntries(['do', 'look', 'get', 'read', 'idea'].map(k => [k, open.filter(i => i.kind === k).length])),
      recentlyAdded: open.sort((a, b) => b.created - a.created).slice(0, 5).map(i => i.title),
    },
    finishedYesterday: items.filter(i => i.done && i.doneAt && dayIn(i.doneAt) === yesterday).length,
  };
}

async function writeBriefing(data, today, t) {
  if (!process.env.ANTHROPIC_API_KEY) { console.log('briefing: skipped (no ANTHROPIC_API_KEY)'); return false; }
  const client = new Anthropic({ maxRetries: 3 });
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system: BRIEFING_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(briefingInput(data, today, t), null, 1) }],
    });
    if (res.stop_reason === 'refusal') { console.log('briefing: declined by the model'); return false; }
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) { console.log('briefing: empty response'); return false; }
    data.briefing = { date: today, text, updated: t };
    console.log(`briefing: written (${text.split(/\s+/).length} words, ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
    return true;
  } catch (e) {
    // a briefing is nice to have; never let it fail the archive step
    if (e instanceof Anthropic.AuthenticationError) console.log('briefing: skipped (Anthropic key rejected)');
    else if (e instanceof Anthropic.RateLimitError) console.log('briefing: skipped (rate limited)');
    else if (e instanceof Anthropic.APIConnectionError) console.log('briefing: skipped (could not reach Anthropic)');
    else if (e instanceof Anthropic.APIError) console.log(`briefing: skipped (Anthropic ${e.status})`);
    else throw e;
    return false;
  }
}

/* ---------- main ---------- */

async function main() {
  const t = Date.now();
  let data, archive;
  if (localFile) {
    data = JSON.parse(await readFile(localFile, 'utf8'));
    archive = JSON.parse(await readFile(outFile.replace(/\.json$/, '') + '.archive.json', 'utf8').catch(() => 'null'));
  } else {
    if (!process.env.GIST_ID || !process.env.GIST_TOKEN) throw new Error('GIST_ID and GIST_TOKEN are required');
    ({ data, archive } = await loadGist());
  }
  if (!data) throw new Error(`${FILE} not found`);
  archive ||= { v: 1, items: {}, today: {} };

  const { today, stats } = tidy(data, archive, t);
  console.log(`date: ${today} (${TZ})`);
  console.log('tidy:', JSON.stringify(stats));
  const briefed = await writeBriefing(data, today, t);

  const changed = briefed || Object.values(stats).some(Boolean);
  if (dryRun) { console.log(`dry run: ${changed ? 'would update' : 'nothing to update'}; nothing written`); return; }
  if (!changed) { console.log('nothing to update'); return; }

  if (localFile) {
    await writeFile(outFile, JSON.stringify(data, null, 2));
    await writeFile(outFile.replace(/\.json$/, '') + '.archive.json', JSON.stringify(archive, null, 2));
    console.log(`wrote ${outFile} and its .archive.json`);
    return;
  }

  // a device may have synced while we worked: fold in its changes before writing
  const latest = await loadGist();
  if (latest.data) data = merge(data, latest.data);
  if (latest.archive) archive = { ...archive, items: { ...latest.archive.items, ...archive.items }, today: { ...latest.archive.today, ...archive.today } };
  await gh(`/gists/${process.env.GIST_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) }, [ARCHIVE]: { content: JSON.stringify(archive) } } }),
  });
  console.log('gist updated');
}

main().catch(e => { console.error(`janitor failed: ${e.message}`); process.exit(1); });
