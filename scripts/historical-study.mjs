/**
 * TEMPORARY diagnostic (throwaway branch diag/nhl-landing, 2026-11-27). Never merged.
 * One-off historical study for the Insights design: fetches 2025-26 regular-season per-game skater
 * data (NHL Stats REST, isGame=true, date ranges sorted by gameId then playerId) and runs
 *  (1) a sample-size study: how well an n-game sample (raw, and blended with a prior) predicts the next 30 games;
 *  (2) a role-change detection study: precision / recall on real windows, false alerts on shuffled windows.
 * Fetched data is never written to disk or uploaded. Results are encrypted with a public key whose private
 * half is held outside this repository; the log shows only progress counts and the ciphertext.
 */
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const PUBLIC_KEY = await readFile('scripts/study-public.pem', 'utf8');
const SEASON = '20252026';
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
  const keys = new Set(rows.map((r) => `${r.gameId}|${r[second]}`));
  if (keys.size !== rows.length) throw new Error(`${path} ${from}: duplicates`);
  return rows;
}

// ---------- fetch ----------
const ranges = [];
for (let d = new Date('2025-10-01T00:00:00Z'); d < new Date('2026-04-25T00:00:00Z'); d = new Date(d.getTime() + 14 * 86400000)) {
  const to = new Date(Math.min(d.getTime() + 13 * 86400000, new Date('2026-04-24T00:00:00Z').getTime()));
  ranges.push([d.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
}
const games = new Map(); // `${gameId}|${playerId}` -> merged line
const teamPp = new Map(); // `${gameId}|${homeRoad}` -> team PP seconds
for (const [from, to] of ranges) {
  const s = await fetchRange('skater/summary', from, to, 'playerId');
  const c = new Map((await fetchRange('skater/scoringpergame', from, to, 'playerId')).map((r) => [`${r.gameId}|${r.playerId}`, r]));
  const t = new Map((await fetchRange('skater/timeonice', from, to, 'playerId')).map((r) => [`${r.gameId}|${r.playerId}`, r]));
  for (const r of await fetchRange('team/powerplay', from, to, 'teamId')) teamPp.set(`${r.gameId}|${r.homeRoad}`, r.ppTimeOnIcePerGame);
  for (const r of s) {
    const k = `${r.gameId}|${r.playerId}`;
    const cc = c.get(k), tt = t.get(k);
    if (!cc || !tt) continue;
    games.set(k, { pid: r.playerId, gameId: r.gameId, date: r.gameDate.slice(0, 10), pos: r.positionCode, homeRoad: r.homeRoad,
      g: r.goals, a: r.assists, pts: r.points, evPts: r.evPoints, ppp: r.ppPoints, shp: r.shPoints, sog: r.shots, pim: r.penaltyMinutes, pm: r.plusMinus,
      hit: cc.hits, blk: cc.blockedShots, toi: tt.timeOnIce, evToi: tt.evTimeOnIce, ppToi: tt.ppTimeOnIce, shToi: tt.shTimeOnIce });
  }
  log(`fetched ${from}..${to}: ${games.size} player-games so far; ${requests} requests`);
}
for (const g of games.values()) g.teamPp = teamPp.get(`${g.gameId}|${g.homeRoad}`) ?? null;

// ---------- per-player series ----------
const byPlayer = new Map();
for (const g of games.values()) byPlayer.set(g.pid, [...(byPlayer.get(g.pid) ?? []), g]);
for (const list of byPlayer.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId - b.gameId));
const group = (pos) => (pos === 'D' ? 'D' : 'F');
const prior2425 = new Map((JSON.parse(await readFile('public/data/skater-stats-20242025.json', 'utf8')).skaters).map((s) => [s.nhlId, s]));

// ---------- statistics ----------
const sum = (gs, f) => gs.reduce((a, g) => a + (g[f] ?? 0), 0);
const STATS = {
  shots_pg: { f: (gs) => sum(gs, 'sog') / gs.length, prior: (p) => p.shots / p.gamesPlayed },
  hits_pg: { f: (gs) => sum(gs, 'hit') / gs.length, prior: (p) => p.hits / p.gamesPlayed },
  blocks_pg: { f: (gs) => sum(gs, 'blk') / gs.length, prior: (p) => p.blockedShots / p.gamesPlayed },
  pim_pg: { f: (gs) => sum(gs, 'pim') / gs.length, prior: (p) => p.penaltyMinutes / p.gamesPlayed },
  plusminus_pg: { f: (gs) => sum(gs, 'pm') / gs.length, prior: (p) => p.plusMinus / p.gamesPlayed },
  points_pg: { f: (gs) => sum(gs, 'pts') / gs.length, prior: (p) => p.points / p.gamesPlayed },
  ppp_pg: { f: (gs) => sum(gs, 'ppp') / gs.length, prior: (p) => p.ppPoints / p.gamesPlayed },
  shp_pg: { f: (gs) => sum(gs, 'shp') / gs.length, prior: (p) => p.shPoints / p.gamesPlayed },
  goals_pg: { f: (gs) => sum(gs, 'g') / gs.length, prior: (p) => p.goals / p.gamesPlayed },
  points_per60: { f: (gs) => (sum(gs, 'toi') > 0 ? (sum(gs, 'pts') / sum(gs, 'toi')) * 3600 : null), prior: (p) => p.points / ((p.toiPerGame * p.gamesPlayed) / 3600) },
  evpoints_per60: { f: (gs) => (sum(gs, 'evToi') > 0 ? (sum(gs, 'evPts') / sum(gs, 'evToi')) * 3600 : null), prior: null },
  pppoints_per60: { f: (gs) => (sum(gs, 'ppToi') >= 600 ? (sum(gs, 'ppp') / sum(gs, 'ppToi')) * 3600 : null), prior: null },
  toi_pg_min: { f: (gs) => sum(gs, 'toi') / gs.length / 60, prior: (p) => p.toiPerGame / 60 },
  evtoi_pg_min: { f: (gs) => sum(gs, 'evToi') / gs.length / 60, prior: null },
  pptoi_pg_min: { f: (gs) => sum(gs, 'ppToi') / gs.length / 60, prior: null },
  ppshare: { f: (gs) => { const t = gs.reduce((a, g) => a + (g.teamPp ?? 0), 0); return t >= 240 ? sum(gs, 'ppToi') / t : null; }, prior: null },
  shooting_pct: { f: (gs) => (sum(gs, 'sog') >= 1 ? sum(gs, 'g') / sum(gs, 'sog') : null), prior: (p) => (p.shots >= 1 ? p.goals / p.shots : null) },
};
const NS = [5, 10, 15, 20, 30];
const OUT = 30;
const KS = [0, 1, 2, 3, 5, 8, 12, 16, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300];
const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r3 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);

// population means per group (2025-26 full seasons) as the fallback prior
const popMean = {};
for (const [name, st] of Object.entries(STATS)) for (const grp of ['F', 'D']) {
  const vals = [...byPlayer.values()].filter((l) => l.length >= 40 && group(l[0].pos) === grp).map((l) => st.f(l)).filter((v) => v !== null);
  popMean[`${name}|${grp}`] = mean(vals);
}

const sampleSize = {};
for (const [name, st] of Object.entries(STATS)) for (const grp of ['F', 'D']) for (const n of NS) {
  const obs = [];
  for (const [pid, list] of byPlayer) {
    if (group(list[0].pos) !== grp) continue;
    const p = prior2425.get(pid);
    const prPlayer = st.prior && p && p.gamesPlayed >= 20 ? st.prior(p) : null;
    const prior = prPlayer ?? popMean[`${name}|${grp}`];
    for (let s = 0; s + n + OUT <= list.length; s += 15) {
      const raw = st.f(list.slice(s, s + n));
      const out = st.f(list.slice(s + n, s + n + OUT));
      if (raw === null || out === null || prior === null || prior === undefined) continue;
      obs.push({ raw, out, prior, hasPlayerPrior: prPlayer !== null });
    }
  }
  if (obs.length < 30) continue;
  const mae = (k) => mean(obs.map((o) => Math.abs((n * o.raw + k * o.prior) / (n + k) - o.out)));
  let bestK = 0, bestMae = Infinity;
  for (const k of KS) { const m = mae(k); if (m < bestMae) { bestMae = m; bestK = k; } }
  const err = obs.map((o) => o.out - (n * o.raw + bestK * o.prior) / (n + bestK));
  const outMean = mean(obs.map((o) => o.out));
  sampleSize[`${name}|${grp}|${n}`] = {
    obs: obs.length, playerPriorShare: r3(obs.filter((o) => o.hasPlayerPrior).length / obs.length), outcomeMean: r3(outMean),
    maeRaw: r3(mae(0)), maePriorOnly: r3(mean(obs.map((o) => Math.abs(o.prior - o.out)))), bestK, maeBest: r3(bestMae),
    currentWeight: r3(n / (n + bestK)), err10: r3(quant(err, 0.1)), err90: r3(quant(err, 0.9)),
  };
}
log(`sample-size study: ${Object.keys(sampleSize).length} cells`);

// ---------- role-change detection ----------
const W = 30, MIN_BEFORE = 10, MIN_AFTER = 3, NEXT = 10;
const series = {
  evtoi: (l) => l.map((g) => g.evToi / 60),
  ppshare: (l) => l.map((g) => (g.teamPp && g.teamPp > 0 ? g.ppToi / g.teamPp : null)).filter((v) => v !== null),
};
function detect(x, dmin) {
  let best = null;
  for (let k = MIN_BEFORE; k <= x.length - MIN_AFTER; k++) {
    const b = x.slice(0, k), a = x.slice(k);
    const mb = mean(b), ma = mean(a), d = ma - mb;
    if (Math.abs(d) < dmin) continue;
    const ss = b.reduce((s, v) => s + (v - mb) ** 2, 0) + a.reduce((s, v) => s + (v - ma) ** 2, 0);
    const sd = Math.sqrt(ss / (x.length - 2)) || 1e-9;
    const z = Math.abs(d) / (sd * Math.sqrt(1 / b.length + 1 / a.length));
    if (!best || z > best.z) best = { z, d, k, mb, ma, after: a.length };
  }
  return best;
}
let seed = 20262027;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const ZS = [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
const DMIN = { evtoi: [1.0, 1.5, 2.0], ppshare: [0.1, 0.15, 0.2] };
const TRUE_D = { evtoi: 1.5, ppshare: 0.15 };
const roleChange = {};
for (const [metric, toSeries] of Object.entries(series)) for (const grp of ['F', 'D', 'all']) {
  const xs = [...byPlayer.values()].filter((l) => grp === 'all' || group(l[0].pos) === grp).map(toSeries).filter((x) => x.length >= W + NEXT);
  for (const dmin of DMIN[metric]) {
    const real = [], shuf = [];
    for (const x of xs) {
      for (let t = W; t + NEXT <= x.length; t += 5) {
        const win = x.slice(t - W, t), next = x.slice(t, t + NEXT);
        const det = detect(win, dmin);
        const base = mean(win.slice(0, W - 8));
        const trueChange = Math.abs(mean([...win.slice(W - 3), ...next]) - base) >= TRUE_D[metric];
        real.push({ z: det?.z ?? 0, sustained: det ? (mean(next) - det.mb) * Math.sign(det.d) >= 0.5 * Math.abs(det.d) : false, trueChange, after: det?.after ?? null });
      }
      for (let rep = 0; rep < 5; rep++) {
        const start = Math.floor(rnd() * (x.length - W + 1));
        const det = detect(shuffle(x.slice(start, start + W)), dmin);
        shuf.push(det?.z ?? 0);
      }
    }
    const rows = ZS.map((Z) => {
      const flagged = real.filter((r) => r.z >= Z);
      const trues = real.filter((r) => r.trueChange);
      return { Z, falseAlertShuffled: r3(shuf.filter((z) => z >= Z).length / shuf.length), alertRateReal: r3(flagged.length / real.length),
        precision: flagged.length ? r3(flagged.filter((r) => r.sustained).length / flagged.length) : null,
        recall: trues.length ? r3(trues.filter((r) => r.z >= Z).length / trues.length) : null,
        medianGamesAfterChange: quant(flagged.map((r) => r.after), 0.5) };
    });
    roleChange[`${metric}|${grp}|dmin${dmin}`] = { players: xs.length, realWindows: real.length, shuffledWindows: shuf.length, trueChangeRate: r3(real.filter((r) => r.trueChange).length / real.length), rows };
  }
}
log(`role-change study: ${Object.keys(roleChange).length} cells`);

// ---------- encrypt and print ----------
const results = JSON.stringify({ season: SEASON, requests, playerGames: games.size, players: byPlayer.size, playersWith40: [...byPlayer.values()].filter((l) => l.length >= 40).length,
  priorPlayers: [...byPlayer.keys()].filter((id) => prior2425.has(id)).length, sampleSize, roleChange });
const key = randomBytes(32), iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(results, 'utf8'), cipher.final()]);
const blob = Buffer.concat([publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key), iv, cipher.getAuthTag(), enc]).toString('base64');
log(`STUDY DONE: ${requests} requests, ${games.size} player-games, encrypted results ${blob.length} chars`);
for (let i = 0; i < blob.length; i += 900) log(`ENC ${String(i / 900).padStart(4, '0')} ${blob.slice(i, i + 900)}`);
log('ENC END');
