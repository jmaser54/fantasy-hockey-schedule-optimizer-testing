/**
 * TEMPORARY diagnostic (throwaway branch diag/nhl-landing, 2026-11-27). Never merged.
 * Follow-up study: power-play promotion detection rules on 2025-26 per-game data (share of team PP time).
 * Fetches skater/timeonice and team/powerplay per-game rows (about 500 requests). Fetched data is never
 * written out; results are printed only encrypted with a public key whose private half is held elsewhere.
 */
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const PUBLIC_KEY = await readFile('scripts/study-public.pem', 'utf8');
const REST = 'https://api.nhle.com/stats/rest/en';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);
let requests = 0;
async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(1500 * 2 ** attempt);
    try {
      requests++;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'fantasy-playoff-optimizer historical study' } });
      await sleep(250);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { last = e; }
  }
  throw last;
}
async function fetchRange(path, from, to, second) {
  const rows = [];
  let total;
  for (let start = 0; start < 100000; start += 100) {
    const p = new URLSearchParams({ isAggregate: 'false', isGame: 'true', start: String(start), limit: '100',
      sort: JSON.stringify([{ property: 'gameId', direction: 'ASC' }, { property: second, direction: 'ASC' }]),
      cayenneExp: `gameTypeId=2 and gameDate<="${to} 23:59:59" and gameDate>="${from}"` });
    const b = await getJson(`${REST}/${path}?${p}`);
    if (total === undefined) total = b.total; else if (b.total !== total) throw new Error(`${path} ${from}: total changed`);
    rows.push(...b.data);
    if (b.data.length < 100 || rows.length >= total) break;
  }
  if (rows.length !== total) throw new Error(`${path} ${from}: ${rows.length}/${total}`);
  if (new Set(rows.map((r) => `${r.gameId}|${r[second]}`)).size !== rows.length) throw new Error(`${path} ${from}: duplicates`);
  return rows;
}

// ---------- fetch ----------
const ranges = [];
for (let d = new Date('2025-10-01T00:00:00Z'); d < new Date('2026-04-25T00:00:00Z'); d = new Date(d.getTime() + 14 * 86400000)) {
  const to = new Date(Math.min(d.getTime() + 13 * 86400000, new Date('2026-04-24T00:00:00Z').getTime()));
  ranges.push([d.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
}
const lines = [];
const teamPp = new Map();
for (const [from, to] of ranges) {
  for (const r of await fetchRange('team/powerplay', from, to, 'teamId')) teamPp.set(`${r.gameId}|${r.homeRoad}`, r.ppTimeOnIcePerGame);
  for (const r of await fetchRange('skater/timeonice', from, to, 'playerId')) lines.push({ pid: r.playerId, gameId: r.gameId, date: r.gameDate.slice(0, 10), pos: r.positionCode, homeRoad: r.homeRoad, ppToi: r.ppTimeOnIce });
  log(`fetched ${from}..${to}: ${lines.length} player-games; ${requests} requests`);
}
const byPlayer = new Map();
for (const l of lines) {
  const t = teamPp.get(`${l.gameId}|${l.homeRoad}`);
  byPlayer.set(l.pid, [...(byPlayer.get(l.pid) ?? []), { ...l, teamPp: t ?? null }]);
}
for (const s of byPlayer.values()) s.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId - b.gameId));

// ---------- series: only games where the team had a meaningful amount of PP time ----------
const MIN_TEAM_PP = 60; // seconds; games below this carry almost no information about PP role
const series = new Map(); // pid -> { pos, x: [{share, teamPp}] }
for (const [pid, s] of byPlayer) {
  const x = s.filter((g) => g.teamPp !== null && g.teamPp >= MIN_TEAM_PP).map((g) => ({ share: Math.min(1, g.ppToi / g.teamPp), teamPp: g.teamPp }));
  if (x.length >= 40) series.set(pid, { pos: s[0].pos === 'D' ? 'D' : 'F', x });
}
const BASE = 20;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const r3 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);

// ---------- true lasting promotions (for recall) ----------
// Onset g: baseline (previous 20 games) B; mean over next 10 and next 30 games (from g) at least B + 0.15; game g itself ≥ B + 0.10.
const TRUE_DELTA = 0.15;
function trueOnsets(x) {
  const out = [];
  let lastOnset = -999;
  for (let g = BASE; g + 30 <= x.length; g++) {
    const B = mean(x.slice(g - BASE, g).map((v) => v.share));
    const n10 = mean(x.slice(g, g + 10).map((v) => v.share));
    const n30 = mean(x.slice(g, g + 30).map((v) => v.share));
    if (x[g].share >= B + 0.1 && n10 >= B + TRUE_DELTA && n30 >= B + TRUE_DELTA && g - lastOnset > 15) { out.push(g); lastOnset = g; }
  }
  return out;
}

// ---------- detection rules ----------
// At game t (after it is played): baseline B = mean of the BASE games before the recent run window.
// Rule parameters: delta (elevation over B), mode 'consec' (last L games all ≥ B+delta) or 'kofn' (k of last n ≥ B+delta,
// including the most recent game when recent=true), dropMax (mean of the run without its largest game still ≥ B+delta),
// minTeamPp (team PP seconds summed over the run), maxBase (baseline must be ≤ this to count as a promotion).
function prep(x) {
  const pre = [0];
  for (const v of x) pre.push(pre[pre.length - 1] + v.share);
  return { x, pre };
}
const meanRange = (P, i, j) => (P.pre[j] - P.pre[i]) / (j - i);
function evaluateAt(P, t, rule) {
  const x = P.x;
  const n = rule.mode === 'consec' ? rule.L : rule.n;
  const s0 = t - n + 1;
  if (s0 - BASE < 0) return null;
  const B = meanRange(P, s0 - BASE, s0);
  if (B > rule.maxBase) return null;
  const thr = B + rule.delta;
  let cnt = 0, mx = -1, tp = 0;
  for (let i = s0; i <= t; i++) { const v = x[i].share; if (v >= thr) cnt++; if (v > mx) mx = v; tp += x[i].teamPp; }
  if (rule.mode === 'consec' && cnt < n) return null;
  if (rule.mode === 'kofn' && (cnt < rule.k || (rule.recent && x[t].share < thr))) return null;
  const runMean = meanRange(P, s0, t + 1);
  const M = runMean - B;
  if (M < rule.minMag) return null;
  if (rule.dropMax && n >= 2 && (runMean * n - mx) / (n - 1) < thr) return null;
  if (tp < rule.minTeamPp) return null;
  return { B, M };
}
function eventsFor(P, rule, horizon) {
  const x = P.x;
  const ev = [];
  let prev = false;
  for (let t = 0; t < x.length - horizon; t++) {
    const r = evaluateAt(P, t, rule);
    const on = !!r;
    if (on && !prev) {
      const n10 = meanRange(P, t + 1, t + 11);
      const n30 = t + 31 <= x.length ? meanRange(P, t + 1, t + 31) : null;
      ev.push({ t, B: r.B, M: r.M, keep10: n10 - r.B >= 0.5 * r.M, ret10: (n10 - r.B) / r.M, keep30: n30 === null ? null : n30 - r.B >= 0.5 * r.M, ret30: n30 === null ? null : (n30 - r.B) / r.M });
    }
    prev = on;
  }
  return ev;
}
let seed = 2026;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const rules = [];
for (const delta of [0.1, 0.15, 0.2, 0.25]) for (const minMag of [0.15, 0.2, 0.3]) for (const dropMax of [false, true]) for (const minTeamPp of [0, 300]) {
  if (minMag < delta) continue;
  for (const L of [1, 2, 3, 4, 5, 6, 8]) rules.push({ mode: 'consec', L, delta, minMag, dropMax, minTeamPp, maxBase: 0.7 });
  for (const [k, n] of [[3, 4], [4, 5], [4, 6], [5, 6], [5, 7], [6, 8]]) rules.push({ mode: 'kofn', k, n, recent: true, delta, minMag, dropMax, minTeamPp, maxBase: 0.7 });
}

const results = [];
const all = [...series.entries()].map(([pid, s]) => ({ pid, pos: s.pos, P: prep(s.x), onsets: trueOnsets(s.x) }));
const totalOnsets = all.reduce((a, p) => a + p.onsets.length, 0);
for (const p of all) p.Pshuf = prep(shuffle(p.P.x));
const summarise = (rows) => {
  const ev = rows.flatMap((r) => r.ev);
  const k30 = ev.filter((v) => v.keep30 !== null);
  const onsets = rows.reduce((a, r) => a + r.onsets, 0);
  const caught = rows.reduce((a, r) => a + r.caught.length, 0);
  return [ev.length, rows.length,
    ev.length ? r3(ev.filter((v) => v.keep10).length / ev.length) : null,
    k30.length ? r3(k30.filter((v) => v.keep30).length / k30.length) : null,
    r3(quant(ev.map((v) => v.ret10), 0.5)), r3(quant(k30.map((v) => v.ret30), 0.5)),
    onsets ? r3(caught / onsets) : null, onsets, quant(rows.flatMap((r) => r.caught), 0.5),
    r3(rows.reduce((a, r) => a + r.shuf, 0) / rows.length), r3(ev.length / rows.length),
    r3(rows.filter((r) => r.shuf > 0).length / rows.length)];
};
for (const rule of rules) {
  const rows = all.map((p) => {
    const ev = eventsFor(p.P, rule, 10);
    const caught = [];
    for (const g of p.onsets) { const hit = ev.find((v) => v.t >= g && v.t <= g + 10); if (hit) caught.push(hit.t - g + 1); }
    return { pos: p.pos, ev, onsets: p.onsets.length, caught, shuf: eventsFor(p.Pshuf, rule, 10).length };
  });
  const r = rule.mode === 'consec' ? `consec L${rule.L}` : `kofn ${rule.k}/${rule.n}`;
  const id = `${r} d${rule.delta} m${rule.minMag}${rule.dropMax ? ' dropMax' : ''}${rule.minTeamPp ? ' tp' + rule.minTeamPp : ''}`;
  results.push([id, 'all', ...summarise(rows)]);
  if (!rule.minTeamPp) { results.push([id, 'F', ...summarise(rows.filter((x) => x.pos === 'F'))]); results.push([id, 'D', ...summarise(rows.filter((x) => x.pos === 'D'))]); }
}
const COLUMNS = ['rule', 'group', 'events', 'playerSeasons', 'precision10', 'precision30', 'retained10Median', 'retained30Median', 'recall', 'trueOnsets', 'medianDelayGames', 'falseEventsPerPlayerSeasonShuffled', 'realEventsPerPlayerSeason', 'shuffledSeasonsWithAlert'];
log(`PP study: ${series.size} player series, ${totalOnsets} true lasting promotions, ${rules.length} rules`);

const payload = JSON.stringify({ requests, playerGames: lines.length, playerSeries: series.size, totalOnsets, minTeamPp: MIN_TEAM_PP, base: BASE, columns: COLUMNS, results });
const key = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
const blob = Buffer.concat([publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key), iv, cipher.getAuthTag(), enc]).toString('base64');
log(`STUDY DONE: ${requests} requests, ${lines.length} player-games, encrypted results ${blob.length} chars`);
for (let i = 0; i < blob.length; i += 900) log(`ENC ${String(i / 900).padStart(4, '0')} ${blob.slice(i, i + 900)}`);
log('ENC END');
