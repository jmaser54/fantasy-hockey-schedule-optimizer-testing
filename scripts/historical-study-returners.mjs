/**
 * TEMPORARY diagnostic (throwaway branch diag/nhl-landing, 2026-11-28). Never merged.
 * Returner opportunity study on 2025-26 per-game data: how ice time and PP share evolve after 5+ missed
 * team games, and how well candidate estimates predict subsequent opportunity (chronological validation).
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

// ---------- 1. trajectories by period ----------
const PERIODS = [[1, 5], [6, 10], [11, 20], [21, 40]];
const traj = { all: {}, mid: {}, start: {} };
for (const grp of Object.keys(traj)) for (const m of MEAS) {
  const eps = episodes.filter((e) => grp === 'all' || (grp === 'start') === e.start);
  traj[grp][m] = PERIODS.map(([a, b]) => {
    const vsPre = [], vsPrior = [], vsEventual = [], level = [];
    for (const e of eps) {
      const g = e.post.slice(a - 1, b); if (g.length < Math.min(5, b - a + 1)) continue;
      const v = agg(g, m); if (v === null) continue; level.push(v);
      const pre = e.pre.length >= 5 ? agg(e.pre, m) : null, pr = priorVal(e, m), ev = e.post.length >= 30 ? agg(e.post.slice(20, 40), m) : null;
      const rel = (x) => (m === 'pp' ? v - x : x > 0.5 ? v / x : null);
      if (pre !== null && (m !== 'pp' || pre >= 0)) { const q = rel(pre); if (q !== null) vsPre.push(q); }
      if (pr !== null) { const q = rel(pr); if (q !== null) vsPrior.push(q); }
      if (ev !== null) { const q = rel(ev); if (q !== null) vsEventual.push(q); }
    }
    return { period: `${a}-${b}`, n: level.length, meanLevel: r3(mean(level)), vsPre: { n: vsPre.length, median: r3(median(vsPre)), mean: r3(mean(vsPre)) }, vsPrior: { n: vsPrior.length, median: r3(median(vsPrior)), mean: r3(mean(vsPrior)) }, vsEventual: { n: vsEventual.length, median: r3(median(vsEventual)), mean: r3(mean(vsEventual)) } };
  });
}

// ---------- 2. recovery classification (eventual = post games 21-40, needs 30+ post games) ----------
const recovery = {};
for (const m of ['toi', 'pp']) for (const refName of ['pre', 'prior']) {
  const out = { below: 0, recovered: 0, above: 0, n: 0, earlyBelow: { n: 0, recoveredOrAbove: 0 } };
  for (const e of episodes) {
    if (e.post.length < 30) continue;
    const ref = refName === 'pre' ? (e.pre.length >= 5 ? agg(e.pre, m) : null) : priorVal(e, m);
    const ev = agg(e.post.slice(20, 40), m), early = agg(e.post.slice(0, 5), m);
    if (ref === null || ev === null || early === null) continue;
    if (m === 'pp' && ref < 0.15) continue; // PP recovery only for players who had a PP role
    const rel = m === 'pp' ? ev - ref : ev / ref, lo = m === 'pp' ? -0.1 : 0.9, hi = m === 'pp' ? 0.1 : 1.1;
    out.n++; if (rel < lo) out.below++; else if (rel > hi) out.above++; else out.recovered++;
    const relE = m === 'pp' ? early - ref : early / ref;
    if (relE < lo) { out.earlyBelow.n++; if (rel >= lo) out.earlyBelow.recoveredOrAbove++; }
  }
  recovery[`${m} vs ${refName}`] = out;
}

// ---------- 3. prediction study ----------
const KS = [1, 2, 3, 5, 8, 10, 15, 20];
const ENGINE_H = { toi: 5, ev: 2, sh: 3, pp: 1 };
// Decision cases: (episode, k) with k post-return games known; targets: next 4 games (short) and next 30 (long, needs 15+).
const cases = [];
for (const e of episodes) for (const k of KS) {
  if (e.post.length < k + 4) continue;
  const known = e.season.slice(0, e.r + k), postK = e.post.slice(0, k);
  const short = e.post.slice(k, k + 4), long = e.post.slice(k, k + 30);
  cases.push({ e, k, known, postK, short, long: long.length >= 15 ? long : null });
}
const methods = {
  season: (c, m) => agg(c.known, m),
  engineNW: (c, m) => { const last = c.known.slice(-10), Lv = agg(last, m), S = agg(c.known, m); if (Lv === null || S === null) return Lv ?? S; const H = ENGINE_H[m]; return (last.length * Lv + H * S) / (last.length + H); },
  recent5: (c, m) => agg(c.postK.slice(-5), m),
  seasonPrior2: (c, m) => { const S = agg(c.known, m), P = priorVal(c.e, m); if (S === null) return P; if (P === null) return S; const n = c.known.length; return (n * S + 2 * P) / (n + 2); },
  priorOnly: (c, m) => priorVal(c.e, m),
  preOnly: (c, m) => (c.e.pre.length >= 5 ? agg(c.e.pre, m) : null),
};
const ref = (c, m) => (c.e.pre.length >= 5 ? agg(c.e.pre, m) : priorVal(c.e, m));
const returnSpecific = (M) => (c, m) => { const P = agg(c.postK, m), R = ref(c, m); if (P === null) return R; if (R === null) return P; return (c.k * P + M * R) / (c.k + M); };
const combo = (w) => (c, m) => { const R = agg(c.postK.slice(-5), m), S = agg(c.known, m); if (R === null || S === null) return R ?? S; return w * R + (1 - w) * S; };
const M_GRID = [0, 1, 2, 3, 5, 8, 12, 20, 40], W_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const target = (c, m, h) => (h === 'short' ? agg(c.short, m) : c.long ? agg(c.long, m) : null);
// A case counts for a measure/horizon only if every method can predict it (same cases for all methods).
const usable = (cs, m, h) => cs.filter((c) => target(c, m, h) !== null && methods.season(c, m) !== null && methods.recent5(c, m) !== null);
const errs = (cs, fn, m, h) => cs.map((c) => { const p = fn(c, m); const t = target(c, m, h); return p === null ? null : Math.abs(p - t); });
const maeOf = (cs, fn, m, h) => { const e = errs(cs, fn, m, h).filter((x) => x !== null); return e.length ? e.reduce((a, b) => a + b, 0) / e.length : null; };
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function bootDiff(cs, fnA, fnB, m, h) { // player-level bootstrap of mean(|A| - |B|) over cases where both predict
  const by = new Map();
  for (const c of cs) { const a = fnA(c, m), b = fnB(c, m), t = target(c, m, h); if (a === null || b === null) continue; (by.get(c.e.pid) ?? by.set(c.e.pid, []).get(c.e.pid)).push(Math.abs(a - t) - Math.abs(b - t)); }
  const groups = [...by.values()]; if (groups.length < 5) return null;
  const stat = (gs) => { let s = 0, n = 0; for (const g of gs) for (const x of g) { s += x; n++; } return s / n; };
  const reps = []; for (let r = 0; r < 1000; r++) reps.push(stat(Array.from({ length: groups.length }, () => groups[Math.floor(rnd() * groups.length)])));
  reps.sort((x, y) => x - y);
  return { players: groups.length, diff: r3(stat(groups)), lo: r3(reps[25]), hi: r3(reps[974]) };
}
const SPLIT = '2026-01-15';
const splits = [
  { name: 'train Oct-mid Jan, test mid Jan-Apr', train: (e) => e.date < SPLIT, test: (e) => e.date >= SPLIT },
  { name: 'reverse: train mid Jan-Apr, test Oct-mid Jan', train: (e) => e.date >= SPLIT, test: (e) => e.date < SPLIT },
];
const prediction = [];
for (const sp of splits) {
  const trainCases = cases.filter((c) => sp.train(c.e));
  const trainPlayers = new Set(trainCases.map((c) => c.e.pid));
  const testCases = cases.filter((c) => sp.test(c.e) && !trainPlayers.has(c.e.pid)); // no player in both
  for (const m of MEAS) for (const h of ['short', 'long']) {
    const tr = usable(trainCases, m, h), te = usable(testCases, m, h);
    if (tr.length < 20 || te.length < 20) { prediction.push({ split: sp.name, m, h, trainCases: tr.length, testCases: te.length, skipped: true }); continue; }
    const bestM = M_GRID.reduce((x, v) => (maeOf(tr, returnSpecific(v), m, h) < maeOf(tr, returnSpecific(x), m, h) ? v : x), M_GRID[0]);
    const bestW = W_GRID.reduce((x, v) => (maeOf(tr, combo(v), m, h) < maeOf(tr, combo(x), m, h) ? v : x), W_GRID[0]);
    const all = { ...methods, [`returnSpecific M=${bestM}`]: returnSpecific(bestM), [`combo w=${bestW}`]: combo(bestW) };
    const res = {};
    for (const [k, fn] of Object.entries(all)) res[k] = { mae: r3(maeOf(te, fn, m, h)), covered: errs(te, fn, m, h).filter((x) => x !== null).length };
    const vsSeason = {};
    for (const k of ['engineNW', 'seasonPrior2', `returnSpecific M=${bestM}`, `combo w=${bestW}`]) vsSeason[k] = bootDiff(te, all[k], methods.season, m, h);
    // by k (small vs larger post-return samples) for the main methods
    const byK = {};
    for (const kk of KS) { const sub = te.filter((c) => c.k === kk); if (sub.length < 10) continue; byK[kk] = { n: sub.length, season: r3(maeOf(sub, methods.season, m, h)), engineNW: r3(maeOf(sub, methods.engineNW, m, h)), recent5: r3(maeOf(sub, methods.recent5, m, h)), seasonPrior2: r3(maeOf(sub, methods.seasonPrior2, m, h)), returnSpecific: r3(maeOf(sub, all[`returnSpecific M=${bestM}`], m, h)), combo: r3(maeOf(sub, all[`combo w=${bestW}`], m, h)) }; }
    // subgroups at the decision point
    const subgroups = {};
    const sg = {
      seasonStartReturns: (c) => c.e.start,
      midSeasonReturns: (c) => !c.e.start,
      fewGamesThisSeason: (c) => c.known.length <= 10,
      currentWellBelowPrior: (c) => { const P = priorVal(c.e, m), S = agg(c.postK, m); return P !== null && S !== null && (m === 'pp' ? S < P - 0.1 : S < 0.85 * P); },
    };
    for (const [k, f] of Object.entries(sg)) { const sub = te.filter(f); if (sub.length < 10) { subgroups[k] = { n: sub.length }; continue; } subgroups[k] = { n: sub.length, players: new Set(sub.map((c) => c.e.pid)).size, season: r3(maeOf(sub, methods.season, m, h)), engineNW: r3(maeOf(sub, methods.engineNW, m, h)), recent5: r3(maeOf(sub, methods.recent5, m, h)), seasonPrior2: r3(maeOf(sub, methods.seasonPrior2, m, h)), returnSpecific: r3(maeOf(sub, all[`returnSpecific M=${bestM}`], m, h)), combo: r3(maeOf(sub, all[`combo w=${bestW}`], m, h)), biasSeason: r3(mean(sub.map((c) => methods.season(c, m) - target(c, m, h)))), biasReturnSpecific: r3(mean(sub.map((c) => all[`returnSpecific M=${bestM}`](c, m) - target(c, m, h)))) }; }
    prediction.push({ split: sp.name, m, h, trainCases: tr.length, testCases: te.length, testPlayers: new Set(te.map((c) => c.e.pid)).size, excludedTestPlayersSeenInTrain: new Set(cases.filter((c) => sp.test(c.e) && trainPlayers.has(c.e.pid)).map((c) => c.e.pid)).size, chosen: { M: bestM, w: bestW }, results: res, vsSeason, byK, subgroups, biasSeason: r3(mean(te.map((c) => methods.season(c, m) - target(c, m, h)))) });
  }
}

// ---------- 4. examples (period averages only) ----------
const exampleOf = (e) => ({ name: e.name, pos: e.pos, return: e.date, missed: e.missed, start: e.start, postGames: e.post.length, preToi: r3(e.pre.length >= 5 ? agg(e.pre, 'toi') : null), priorToi: r3(priorVal(e, 'toi')), prePp: r3(e.pre.length >= 5 ? agg(e.pre, 'pp') : null), priorPp: r3(priorVal(e, 'pp')), periods: PERIODS.map(([a, b]) => { const g = e.post.slice(a - 1, b); return g.length ? { p: `${a}-${b}`, n: g.length, toi: r3(agg(g, 'toi')), pp: r3(agg(g, 'pp')) } : null; }).filter(Boolean) });
const long = episodes.filter((e) => e.post.length >= 30 && (e.pre.length >= 5 || e.prior));
const cls = (e) => { const r = e.pre.length >= 5 ? agg(e.pre, 'toi') : priorVal(e, 'toi'); const ev = agg(e.post.slice(20, 40), 'toi'); return ev / r; };
const sorted = long.filter((e) => (e.pre.length >= 5 ? agg(e.pre, 'toi') : priorVal(e, 'toi')) > 12).sort((a, b) => cls(a) - cls(b));
const examples = { stayedReduced: sorted.slice(0, 8).map(exampleOf), recovered: sorted.filter((e) => Math.abs(cls(e) - 1) < 0.05 && agg(e.post.slice(0, 5), 'toi') < 0.9 * (e.pre.length >= 5 ? agg(e.pre, 'toi') : priorVal(e, 'toi'))).slice(0, 8).map(exampleOf), increased: sorted.slice(-8).map(exampleOf) };
const named = episodes.filter((e) => /Marchand|Barkov/.test(e.name ?? '')).map(exampleOf);

const payload = JSON.stringify({ requests, playerGames: lines.length, rowsWithoutTeam: noTeam, priorFields: fieldsSeen, priorPlayers: prior.size, leaguePpPg: Math.round(leaguePpPg),
  cohort: { episodes: episodes.length, players: new Set(episodes.map((e) => e.pid)).size, seasonStart: episodes.filter((e) => e.start).length, midSeason: episodes.filter((e) => !e.start).length, withPre5: episodes.filter((e) => e.pre.length >= 5).length, withPrior: episodes.filter((e) => e.prior).length, post10: episodes.filter((e) => e.post.length >= 10).length, post20: episodes.filter((e) => e.post.length >= 20).length, post30: episodes.filter((e) => e.post.length >= 30).length, post40: episodes.filter((e) => e.post.length >= 40).length, missedMedian: median(episodes.map((e) => e.missed)), byPos: { F: episodes.filter((e) => e.pos === 'F').length, D: episodes.filter((e) => e.pos === 'D').length }, firstHalf: episodes.filter((e) => e.date < SPLIT).length, secondHalf: episodes.filter((e) => e.date >= SPLIT).length, exclusions: excl, cases: cases.length },
  traj, recovery, prediction, examples, named });
const key = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
const blob = Buffer.concat([publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key), iv, cipher.getAuthTag(), enc]).toString('base64');
log(`STUDY DONE: ${requests} requests, ${lines.length} player-games, encrypted results ${blob.length} chars`);
for (let i = 0; i < blob.length; i += 900) log(`ENC ${String(i / 900).padStart(4, '0')} ${blob.slice(i, i + 900)}`);
log('ENC END');
