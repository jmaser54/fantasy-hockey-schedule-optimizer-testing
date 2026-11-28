/**
 * TEMPORARY diagnostic (throwaway branch diag/nhl-landing, 2026-11-28). Never merged.
 * Returner diagnostic (a) on 2025-26 per-game data: return-specific estimate vs the engine Next Week formula,
 * with intervals, against matched non-return placebo periods; plus the prior-season anchor for (b).
 * Fetches skater/timeonice and team/powerplay per-game rows plus 2024-25 season time-on-ice totals.
 * Fetched data is never written out; only aggregates are printed, encrypted with a public key whose private
 * half is held elsewhere.
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
async function fetchPaged(path, cayenneExp, second, isGame) {
  const rows = [];
  let total;
  for (let start = 0; start < 200000; start += 100) {
    const p = new URLSearchParams({ isAggregate: 'false', isGame: String(isGame), start: String(start), limit: '100',
      sort: JSON.stringify(isGame ? [{ property: 'gameId', direction: 'ASC' }, { property: second, direction: 'ASC' }] : [{ property: second, direction: 'ASC' }]), cayenneExp });
    const b = await getJson(`${REST}/${path}?${p}`);
    if (total === undefined) total = b.total; else if (b.total !== total) throw new Error(`${path}: total changed`);
    rows.push(...b.data);
    if (b.data.length < 100 || rows.length >= total) break;
  }
  if (rows.length !== total) throw new Error(`${path}: ${rows.length}/${total}`);
  return rows;
}

// ---------- fetch 2025-26 per-game rows ----------
const ranges = [];
for (let d = new Date('2025-10-01T00:00:00Z'); d < new Date('2026-04-25T00:00:00Z'); d = new Date(d.getTime() + 14 * 86400000)) {
  const to = new Date(Math.min(d.getTime() + 13 * 86400000, new Date('2026-04-24T00:00:00Z').getTime()));
  ranges.push([d.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
}
const teamOf = new Map(); // `${gameId}|${homeRoad}` -> { teamId, pp }
const lines = [];
const names = new Map();
for (const [from, to] of ranges) {
  const exp = `gameTypeId=2 and gameDate<="${to} 23:59:59" and gameDate>="${from}"`;
  for (const r of await fetchPaged('team/powerplay', exp, 'teamId', true)) teamOf.set(`${r.gameId}|${r.homeRoad}`, { teamId: r.teamId, pp: r.ppTimeOnIcePerGame, date: r.gameDate.slice(0, 10) });
  const t = await fetchPaged('skater/timeonice', exp, 'playerId', true);
  if (new Set(t.map((r) => `${r.gameId}|${r.playerId}`)).size !== t.length) throw new Error(`timeonice ${from}: duplicates`);
  for (const r of t) {
    names.set(r.playerId, r.skaterFullName);
    lines.push({ pid: r.playerId, gameId: r.gameId, date: r.gameDate.slice(0, 10), pos: r.positionCode, homeRoad: r.homeRoad, toi: r.timeOnIce, ev: r.evTimeOnIce, pp: r.ppTimeOnIce, sh: r.shTimeOnIce });
  }
  log(`fetched ${from}..${to}: ${lines.length} player-games; ${requests} requests`);
}
// ---------- 2024-25 season totals (prior-season role) ----------
const priorRows = await fetchPaged('skater/timeonice', 'gameTypeId=2 and seasonId<=20242025 and seasonId>=20242025', 'playerId', false);
const priorTeam = await fetchPaged('team/powerplay', 'gameTypeId=2 and seasonId<=20242025 and seasonId>=20242025', 'teamId', false);
const leaguePpPg = priorTeam.reduce((a, r) => a + (r.ppTimeOnIcePerGame ?? 0), 0) / Math.max(1, priorTeam.filter((r) => r.ppTimeOnIcePerGame).length);
const fieldsSeen = priorRows.length ? Object.keys(priorRows[0]).filter((k) => /time|games/i.test(k)) : [];
const prior = new Map();
for (const r of priorRows) {
  const gp = r.gamesPlayed;
  if (!(gp >= 20)) continue;
  const toi = r.timeOnIcePerGame, ev = r.evTimeOnIcePerGame, pp = r.ppTimeOnIcePerGame, sh = r.shTimeOnIcePerGame;
  if (typeof toi !== 'number') continue;
  prior.set(r.playerId, { gp, toi, ev: typeof ev === 'number' ? ev : null, sh: typeof sh === 'number' ? sh : null, ppShare: typeof pp === 'number' && leaguePpPg > 0 ? Math.min(1, pp / leaguePpPg) : null });
}
log(`prior season: ${priorRows.length} rows, ${prior.size} with 20+ GP; league PP per team-game ${Math.round(leaguePpPg)} s`);

// ---------- team schedules and player series ----------
const teamGames = new Map(); // teamId -> sorted [{gameId, date}]
for (const [k, v] of teamOf) { const gameId = Number(k.split('|')[0]); (teamGames.get(v.teamId) ?? teamGames.set(v.teamId, []).get(v.teamId)).push({ gameId, date: v.date }); }
for (const s of teamGames.values()) s.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId - b.gameId));
const teamIndex = new Map(); // `${teamId}|${gameId}` -> index in team schedule
for (const [t, s] of teamGames) s.forEach((g, i) => teamIndex.set(`${t}|${g.gameId}`, i));
const byPlayer = new Map();
let noTeam = 0;
for (const l of lines) {
  const t = teamOf.get(`${l.gameId}|${l.homeRoad}`);
  if (!t) { noTeam++; continue; }
  (byPlayer.get(l.pid) ?? byPlayer.set(l.pid, []).get(l.pid)).push({ ...l, teamId: t.teamId, teamPp: t.pp ?? null, ti: teamIndex.get(`${t.teamId}|${l.gameId}`) });
}
for (const s of byPlayer.values()) s.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId - b.gameId));

// ---------- episodes ----------
const L = 5;
const episodes = [];
const excl = { teamChanged: 0, goalie: 0, tooFewPost: 0 };
for (const [pid, s] of byPlayer) {
  if (s[0].pos === 'G') { excl.goalie++; continue; }
  const rets = []; // indices of return games with gap info
  if (s[0].ti >= L) rets.push({ i: 0, missed: s[0].ti, start: true });
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (a.teamId !== b.teamId) continue; // traded: a gap across teams is not treated as an absence (counted below)
    const missed = b.ti - a.ti - 1;
    if (missed >= L) rets.push({ i, missed, start: false });
  }
  // team change across an absence: previous game on another team and the gap on the new team >= L
  for (let i = 1; i < s.length; i++) if (s[i - 1].teamId !== s[i].teamId && s[i].ti >= L) excl.teamChanged++;
  rets.forEach((r, j) => {
    const end = j + 1 < rets.length ? rets[j + 1].i : s.length; // stop before the next absence
    const pre = s.slice(Math.max(0, r.i - 20), r.i).filter((g) => g.teamId === s[r.i].teamId);
    const post = s.slice(r.i, end);
    if (post.length < 5) { excl.tooFewPost++; return; }
    episodes.push({ pid, pos: s[0].pos === 'D' ? 'D' : 'F', name: names.get(pid), date: s[r.i].date, missed: r.missed, start: r.start, season: s.slice(0, end), r: r.i, pre, post, prior: prior.get(pid) ?? null });
  });
}
log(`episodes: ${episodes.length} (players ${new Set(episodes.map((e) => e.pid)).size}); exclusions ${JSON.stringify(excl)}; rows without team ${noTeam}`);

// ---------- helpers ----------
const MEAS = ['toi', 'ev', 'sh', 'pp'];
const agg = (games, m) => {
  if (!games.length) return null;
  if (m === 'pp') { let a = 0, t = 0; for (const g of games) if (g.teamPp !== null && g.teamPp > 0) { a += g.pp; t += g.teamPp; } return t >= 120 ? Math.min(1, a / t) : null; }
  return games.reduce((x, g) => x + (g[m] ?? 0), 0) / games.length / 60; // minutes
};
const priorVal = (e, m) => (e.prior ? (m === 'pp' ? e.prior.ppShare : e.prior[m] === null ? null : e.prior[m] / 60) : null);
const r3 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };


// ---------- diagnostic (a): return-specific vs engine Next Week, with placebo ----------
const MEAS3 = ['toi', 'ev', 'sh'];
const KS = [1, 2, 3, 5, 8, 10];
const H_NW = { toi: 5, ev: 2, sh: 3 };
const M_RS = 2, W_PRIOR = 2;
let seed = 20261128; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// A decision case: known season games so far, the k games since the anchor, the reference role, the next 4 games.
const engineNW = (known, m) => { const last = known.slice(-10), Lv = agg(last, m), S = agg(known, m); if (Lv === null || S === null) return Lv ?? S; return (last.length * Lv + H_NW[m] * S) / (last.length + H_NW[m]); };
const rs = (postK, ref, m) => { const P = agg(postK, m); if (P === null) return ref; if (ref === null) return P; return (postK.length * P + M_RS * ref) / (postK.length + M_RS); };
const anchorPrior = (v, n, P) => (v === null ? P : P === null ? v : (n * v + W_PRIOR * P) / (n + W_PRIOR));
function makeCase(pid, pos, date, kind, seasonGames, a, k, refGames, priorRec) {
  const known = seasonGames.slice(0, a + k), postK = seasonGames.slice(a, a + k), next = seasonGames.slice(a + k, a + k + 4), next30 = seasonGames.slice(a + k, a + k + 30);
  if (next.length < 4) return null;
  return { pid, pos, date, kind, k, n: known.length, known, postK, next, next30: next30.length >= 15 ? next30 : null, refGames, prior: priorRec };
}
const priorOf = (c, m) => (c.prior ? (c.prior[m] === null ? null : c.prior[m] / 60) : null);
const refOf = (c, m) => (c.refGames && c.refGames.length >= 5 ? agg(c.refGames, m) : priorOf(c, m));

// Return cases (same episodes as the study).
const retCases = [];
for (const e of episodes) for (const k of KS) {
  if (e.post.length < k + 4) continue;
  const c = makeCase(e.pid, e.pos, e.date, e.start ? 'seasonStart' : 'midSeason', e.season, e.r, k, e.pre, e.prior);
  if (c) retCases.push(c);
}
// Placebo cases: anchors at random games of players' seasons with no 5+ team-game gap from 20 games before the
// anchor to the end of the next-4 window, at least 10 games after any return, matched to each mid-season
// return case on position, k, season games before the anchor (within 3) and date (within 21 days).
const isGapAt = (s, i) => i > 0 && s[i - 1].teamId === s[i].teamId && s[i].ti - s[i - 1].ti - 1 >= L;
const candidates = [];
for (const [pid, s] of byPlayer) {
  if (s[0].pos === 'G') continue;
  const gaps = s.map((_, i) => isGapAt(s, i) || (i > 0 && s[i - 1].teamId !== s[i].teamId));
  for (let a = 5; a < s.length - 5; a++) {
    let ok = true;
    for (let j = Math.max(1, a - 20); j <= Math.min(s.length - 1, a + 14) && ok; j++) if (gaps[j]) ok = false;
    if (ok) candidates.push({ pid, pos: s[0].pos === 'D' ? 'D' : 'F', s, a, date: s[a].date });
  }
}
const retPids = new Set(episodes.map((e) => e.pid));
const placeboCases = [];
let unmatched = 0;
for (const c of retCases.filter((x) => x.kind === 'midSeason')) {
  const pre = c.n - c.k;
  const pool = candidates.filter((p) => p.pos === c.pos && Math.abs(p.a - pre) <= 3 && Math.abs(new Date(p.date) - new Date(c.date)) <= 21 * 86400000 && p.s.length >= p.a + c.k + 4 && p.pid !== c.pid);
  if (!pool.length) { unmatched++; continue; }
  for (let r = 0; r < 3; r++) {
    const p = pool[Math.floor(rnd() * pool.length)];
    const pc = makeCase(p.pid, p.pos, p.date, 'placebo', p.s, p.a, c.k, p.s.slice(Math.max(0, p.a - 20), p.a), prior.get(p.pid) ?? null);
    if (pc) placeboCases.push(pc);
  }
}
log(`cases: returns ${retCases.length}, placebo ${placeboCases.length} (unmatched return cases ${unmatched}), candidate anchors ${candidates.length}`);

// Paired difference per case; player-clustered bootstrap.
function gains(cs, m, fnA, fnB, horizon = 'next') {
  const by = new Map();
  for (const c of cs) {
    const t = horizon === 'next' ? agg(c.next, m) : c.next30 ? agg(c.next30, m) : null; if (t === null) continue;
    const a = fnA(c, m), b = fnB(c, m); if (a === null || b === null) continue;
    (by.get(c.pid) ?? by.set(c.pid, []).get(c.pid)).push({ d: Math.abs(a - t) - Math.abs(b - t), ea: Math.abs(a - t), eb: Math.abs(b - t) });
  }
  return [...by.values()];
}
const statOf = (gs) => { let s = 0, n = 0; for (const g of gs) for (const x of g) { s += x.d; n++; } return n ? s / n : NaN; };
const boot = (gs) => Array.from({ length: 1000 }, () => statOf(Array.from({ length: gs.length }, () => gs[Math.floor(rnd() * gs.length)]))).sort((x, y) => x - y);
function summary(gs) {
  if (gs.length < 5) return { players: gs.length, skipped: true };
  const reps = boot(gs); const n = gs.reduce((a, g) => a + g.length, 0);
  const ea = gs.reduce((a, g) => a + g.reduce((x, y) => x + y.ea, 0), 0) / n, eb = gs.reduce((a, g) => a + g.reduce((x, y) => x + y.eb, 0), 0) / n;
  return { players: gs.length, cases: n, maeA: r3(ea), maeB: r3(eb), diff: r3(statOf(gs)), lo: r3(reps[25]), hi: r3(reps[974]) };
}
function diffOfDiffs(gA, gB) { // independent player bootstraps of each group
  if (gA.length < 5 || gB.length < 5) return null;
  const a = boot(gA), b = boot(gB); const d = a.map((x, i) => x - b[Math.floor(rnd() * b.length)]).sort((x, y) => x - y);
  return { diff: r3(statOf(gA) - statOf(gB)), lo: r3(d[25]), hi: r3(d[974]) };
}
const RS = (c, m) => rs(c.postK, refOf(c, m), m);
const NW = (c, m) => engineNW(c.known, m);
const SEASON = (c, m) => agg(c.known, m);
const NW_P2 = (c, m) => anchorPrior(engineNW(c.known, m), c.n, priorOf(c, m));
const SEASON_P2 = (c, m) => anchorPrior(agg(c.known, m), c.n, priorOf(c, m));
const groups = {
  returnsMidSeason: retCases.filter((c) => c.kind === 'midSeason'),
  returnsSeasonStart: retCases.filter((c) => c.kind === 'seasonStart'),
  returnsAll: retCases,
  placebo: placeboCases,
};
const SPLIT = '2026-01-15';
const out = { a: {}, aByK: {}, aByHalf: {}, placeboVsReturn: {}, b: {} };
for (const m of MEAS3) {
  out.a[m] = {}; out.aByK[m] = {}; out.aByHalf[m] = {};
  for (const [g, cs] of Object.entries(groups)) {
    out.a[m][g] = summary(gains(cs, m, RS, NW));
    out.aByK[m][g] = Object.fromEntries(KS.map((k) => [k, summary(gains(cs.filter((c) => c.k === k), m, RS, NW))]));
    out.aByHalf[m][g] = { firstHalf: summary(gains(cs.filter((c) => c.date < SPLIT), m, RS, NW)), secondHalf: summary(gains(cs.filter((c) => c.date >= SPLIT), m, RS, NW)) };
  }
  out.placeboVsReturn[m] = diffOfDiffs(gains(groups.returnsMidSeason, m, RS, NW), gains(groups.placebo, m, RS, NW));
  // (b) checks: the prior-season anchor on the engine Next Week value (next 4) and on the season average (next 30), for everyone.
  const everyone = [...retCases, ...placeboCases];
  out.b[m] = {
    nwAnchorNext4_returns: summary(gains(retCases, m, NW_P2, NW)),
    nwAnchorNext4_placebo: summary(gains(placeboCases, m, NW_P2, NW)),
    nwAnchorNext4_few10: summary(gains(everyone.filter((c) => c.n <= 10), m, NW_P2, NW)),
    seasonAnchorNext30_returns: summary(gains(retCases, m, SEASON_P2, SEASON, 'next30')),
    seasonAnchorNext30_placebo: summary(gains(placeboCases, m, SEASON_P2, SEASON, 'next30')),
  };
}
const payload = JSON.stringify({ requests, playerGames: lines.length, priorPlayers: prior.size, settings: { M_RS, W_PRIOR, KS, H_NW, placeboPerReturnCase: 3, match: 'position, k, season games before anchor within 3, date within 21 days; anchor needs no 5+ gap from 20 before to next-4 end and 10 games clear of returns' },
  counts: { episodes: episodes.length, players: new Set(episodes.map((e) => e.pid)).size, returnCases: retCases.length, midSeasonCases: groups.returnsMidSeason.length, seasonStartCases: groups.returnsSeasonStart.length, placeboCases: placeboCases.length, placeboPlayers: new Set(placeboCases.map((c) => c.pid)).size, placeboPlayersAlsoReturners: new Set(placeboCases.filter((c) => retPids.has(c.pid)).map((c) => c.pid)).size, unmatched, candidates: candidates.length }, ...out });
const key = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
const blob = Buffer.concat([publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key), iv, cipher.getAuthTag(), enc]).toString('base64');
log(`STUDY DONE: ${requests} requests, ${lines.length} player-games, encrypted results ${blob.length} chars`);
for (let i = 0; i < blob.length; i += 900) log(`ENC ${String(i / 900).padStart(4, '0')} ${blob.slice(i, i + 900)}`);
log('ENC END');
