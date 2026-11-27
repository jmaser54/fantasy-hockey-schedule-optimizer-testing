/**
 * TEMPORARY diagnostic on the throwaway branch diag/nhl-landing (2026-11-27, run 4). Never merged.
 * Final validation probe, read-only:
 *  - full run (on 2026-11-27 UTC): date-range pagination, power-play share cross-check, baseline digests;
 *  - later runs (manual re-runs of this workflow): availability and correction digests only.
 */
const SEASON = process.env.SEASON ?? '20262027';
const REST = 'https://api.nhle.com/stats/rest/en';
const WEB = 'https://api-web.nhle.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);
const NOW = new Date().toISOString();
const FULL = NOW.slice(0, 10) === '2026-11-27';
let requests = 0;

async function get(url) {
  requests++;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'fantasy-playoff-optimizer insights validation probe' } });
    const text = await res.text();
    await sleep(300);
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, bytes: text.length, body };
  } catch (e) {
    return { status: 0, bytes: 0, error: String(e) };
  }
}
const short = (v, n = 600) => { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
const exp = (from, to) => `gameTypeId=2 and gameDate<="${to} 23:59:59" and gameDate>="${from}"`;
const url = (path, { cayenne, sort, start = 0, game = true }) =>
  `${REST}/${path}?${new URLSearchParams({ isAggregate: 'false', isGame: String(game), start: String(start), limit: '100', sort: JSON.stringify(sort), cayenneExp: cayenne })}`;

/** Page a report until `total`; returns rows, pages and totals seen. */
async function pageAll(path, cayenne, sort, game = true) {
  const rows = [];
  const totals = new Set();
  let pages = 0;
  for (let start = 0; start < 5000; start += 100) {
    const r = await get(url(path, { cayenne, sort, start, game }));
    pages++;
    const data = Array.isArray(r.body?.data) ? r.body.data : [];
    if (r.status !== 200) log(`  ${path} page ${pages}: HTTP ${r.status} ${r.error ?? short(r.body, 200)}`);
    totals.add(r.body?.total);
    rows.push(...data);
    if (data.length < 100 || rows.length >= (r.body?.total ?? 0)) break;
  }
  return { rows, pages, totals: [...totals] };
}
const BY_PLAYER = [{ property: 'playerId', direction: 'ASC' }];
const BY_GAME_PLAYER = [{ property: 'gameId', direction: 'ASC' }, { property: 'playerId', direction: 'ASC' }];
const key = (r) => `${r.gameId}|${r.playerId}`;

log(`PROBE 4 at ${NOW} (mode ${FULL ? 'full' : 'recheck'})`);

if (FULL) {
  // 1. Date-range pagination over four game nights.
  const FROM = '2026-11-22', TO = '2026-11-25', DATES = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'];
  const before = requests;
  const multi = await pageAll('skater/summary', exp(FROM, TO), BY_GAME_PLAYER);
  const multiReq = requests - before;
  const single = await pageAll('skater/summary', exp(FROM, TO), BY_PLAYER);
  const singleReq = requests - before - multiReq;
  const perDate = new Map();
  let perDateReq = 0;
  for (const d of DATES) {
    const b = requests;
    const r = await pageAll('skater/summary', exp(d, d), BY_PLAYER);
    perDateReq += requests - b;
    for (const row of r.rows) perDate.set(key(row), row);
    log(`  per-date ${d}: ${r.rows.length} rows, ${r.pages} pages, totals ${r.totals}`);
  }
  const report = (label, res, reqs) => {
    const keys = res.rows.map(key);
    const uniq = new Set(keys);
    const missing = [...perDate.keys()].filter((k) => !uniq.has(k));
    const extra = [...uniq].filter((k) => !perDate.has(k));
    let diffs = 0;
    for (const row of res.rows) {
      const p = perDate.get(key(row));
      if (p && ['goals', 'assists', 'points', 'shots', 'plusMinus', 'ppPoints', 'timeOnIcePerGame'].some((f) => p[f] !== row[f])) diffs++;
    }
    log(`PAGINATION ${label}: ${reqs} requests, ${res.pages} pages, totals reported ${res.totals}, rows ${keys.length}, distinct game-player ${uniq.size}, duplicates ${keys.length - uniq.size}, missing vs per-date ${missing.length}, extra ${extra.length}, value differences ${diffs}${missing.length ? ' e.g. missing ' + missing.slice(0, 5) : ''}`);
  };
  log(`PAGINATION per-date union: ${perDate.size} game-player rows from ${perDateReq} requests; games ${new Set([...perDate.values()].map((r) => r.gameId)).size}`);
  report('range sorted by gameId+playerId', multi, multiReq);
  report('range sorted by playerId only', single, singleReq);

  // 3. Power-play share on 2026-11-25: NHL ppTimeOnIcePctPerGame vs player ppTimeOnIce / team ppTimeOnIcePerGame.
  const D = '2026-11-25';
  const pp = await pageAll('skater/powerplay', exp(D, D), BY_GAME_PLAYER);
  const team = await pageAll('team/powerplay', exp(D, D), [{ property: 'gameId', direction: 'ASC' }, { property: 'teamId', direction: 'ASC' }]);
  const teamBy = new Map(team.rows.map((t) => [`${t.gameId}|${t.homeRoad}`, t]));
  const cmp = [];
  for (const p of pp.rows) {
    const t = teamBy.get(`${p.gameId}|${p.homeRoad}`);
    if (!t) continue;
    const own = t.ppTimeOnIcePerGame > 0 ? p.ppTimeOnIce / t.ppTimeOnIcePerGame : null;
    cmp.push({ name: p.skaterFullName, team: p.teamAbbrev, gameId: p.gameId, ppToi: p.ppTimeOnIce, teamPp: t.ppTimeOnIcePerGame, teamOpp: t.ppOpportunities, nhl: p.ppTimeOnIcePctPerGame, own });
  }
  const withPp = cmp.filter((c) => c.own !== null);
  const diff = withPp.map((c) => Math.abs(c.nhl - c.own));
  const within = (tol) => diff.filter((d) => d <= tol).length;
  log(`\nPP SHARE game level ${D}: ${pp.rows.length} skater rows (${pp.pages} pages), ${team.rows.length} team rows; compared ${withPp.length}; |NHL - own| max ${Math.max(...diff).toFixed(4)}, within 0.001: ${within(0.001)}, within 0.005: ${within(0.005)}, within 0.01: ${within(0.01)}`);
  log(`  team PP time zero (share undefined): ${cmp.filter((c) => c.own === null).length} rows; their NHL values ${short([...new Set(cmp.filter((c) => c.own === null).map((c) => c.nhl))])}`);
  const over = withPp.filter((c) => c.own > 1.0001);
  log(`  own share > 1 (player PP time above team PP time): ${over.length}${over.length ? ' e.g. ' + short(over.slice(0, 3)) : ''}`);
  const worst = withPp.map((c, i) => ({ ...c, d: diff[i] })).sort((a, b) => b.d - a.d).slice(0, 5);
  log(`  largest differences: ${short(worst, 1500)}`);
  const sorted = [...withPp].sort((a, b) => b.ppToi - a.ppToi);
  const ex = [...sorted.slice(0, 4), ...sorted.filter((c) => c.ppToi > 0 && c.ppToi < 30).slice(0, 3), ...sorted.filter((c) => c.ppToi === 0).slice(0, 2)];
  for (const c of ex) log(`  example ${c.name} ${c.team} game ${c.gameId}: PP ${c.ppToi}s / team PP ${c.teamPp}s (${c.teamOpp} opp) → own ${c.own.toFixed(4)} vs NHL ${c.nhl}`);

  // Season level: NHL season pct vs player ppTimeOnIce / (team ppTimeOnIcePerGame × team gamesPlayed).
  const sPp = await get(url('skater/powerplay', { cayenne: `gameTypeId=2 and seasonId<=${SEASON} and seasonId>=${SEASON}`, sort: [{ property: 'ppTimeOnIce', direction: 'DESC' }, { property: 'playerId', direction: 'ASC' }], game: false }));
  const sTeam = await get(url('team/powerplay', { cayenne: `gameTypeId=2 and seasonId<=${SEASON} and seasonId>=${SEASON}`, sort: [{ property: 'teamId', direction: 'ASC' }], game: false }));
  // teamId → abbrev from the game-level rows (team row and skater rows share gameId + homeRoad).
  const abbrevOf = new Map();
  for (const p of pp.rows) { const t = teamBy.get(`${p.gameId}|${p.homeRoad}`); if (t) abbrevOf.set(t.teamId, p.teamAbbrev); }
  const teamSeason = new Map((sTeam.body?.data ?? []).map((t) => [abbrevOf.get(t.teamId), t]));
  const sRows = (sPp.body?.data ?? []).filter((p) => !String(p.teamAbbrevs).includes(','));
  const sCmp = [];
  for (const p of sRows) {
    const t = teamSeason.get(p.teamAbbrevs);
    if (!t) continue;
    const teamTotal = t.ppTimeOnIcePerGame * t.gamesPlayed;
    sCmp.push({ name: p.skaterFullName, team: p.teamAbbrevs, gp: p.gamesPlayed, teamGp: t.gamesPlayed, nhl: p.ppTimeOnIcePctPerGame, ownTeamSeason: p.ppTimeOnIce / teamTotal });
  }
  const full = sCmp.filter((c) => c.gp === c.teamGp), part = sCmp.filter((c) => c.gp < c.teamGp);
  const dmax = (xs) => (xs.length ? Math.max(...xs.map((c) => Math.abs(c.nhl - c.ownTeamSeason))).toFixed(4) : '-');
  log(`\nPP SHARE season (top 100 by PP time, single-team players, team map for ${abbrevOf.size} teams): compared ${sCmp.length}; played every team game ${full.length} (max |diff| ${dmax(full)}), missed games ${part.length} (max |diff| ${dmax(part)})`);
  for (const c of [...full.slice(0, 3), ...part.slice(0, 4)]) log(`  season ${c.name} ${c.team} GP ${c.gp}/${c.teamGp}: NHL ${c.nhl} vs own (whole team season) ${c.ownTeamSeason.toFixed(4)}`);
}

// 2. Availability and corrections: per-game digests for a settled night and tonight's games.
const score = await get(`${WEB}/score/2026-11-27`);
const sg = Array.isArray(score.body?.games) ? score.body.games : [];
log(`\nSCORE 2026-11-27: HTTP ${score.status}, games ${sg.length}: ${sg.map((g) => `${g.id}:${g.gameState}@${g.startTimeUTC}`).join(' ')}`);
for (const D of ['2026-11-25', '2026-11-27']) {
  const s = await pageAll('skater/summary', exp(D, D), BY_GAME_PLAYER);
  const c = await pageAll('skater/scoringpergame', exp(D, D), BY_GAME_PLAYER);
  const t = await pageAll('team/powerplay', exp(D, D), [{ property: 'gameId', direction: 'ASC' }, { property: 'teamId', direction: 'ASC' }]);
  const g = await pageAll('goalie/summary', exp(D, D), BY_GAME_PLAYER);
  const games = [...new Set([...s.rows, ...t.rows].map((r) => r.gameId))].sort();
  log(`DIGEST ${D} at ${NOW}: skater rows ${s.rows.length}, scoring rows ${c.rows.length}, team rows ${t.rows.length}, goalie rows ${g.rows.length}, games ${games.length}`);
  const sum = (rows, gid, f) => rows.filter((r) => r.gameId === gid).reduce((a, r) => a + (Number(r[f]) || 0), 0);
  for (const gid of games) {
    const parts = [
      `n=${s.rows.filter((r) => r.gameId === gid).length}`,
      ...['goals', 'assists', 'shots', 'ppPoints', 'penaltyMinutes', 'timeOnIcePerGame'].map((f) => `${f}=${sum(s.rows, gid, f)}`),
      `absPM=${s.rows.filter((r) => r.gameId === gid).reduce((a, r) => a + Math.abs(r.plusMinus ?? 0), 0)}`,
      ...['hits', 'blockedShots', 'totalPrimaryAssists', 'totalSecondaryAssists'].map((f) => `${f}=${sum(c.rows, gid, f)}`),
      `teamPPtoi=${sum(t.rows, gid, 'ppTimeOnIcePerGame')}`, `teamPPopp=${sum(t.rows, gid, 'ppOpportunities')}`,
      `gSaves=${sum(g.rows, gid, 'saves')}`, `gSA=${sum(g.rows, gid, 'shotsAgainst')}`, `gStarts=${sum(g.rows, gid, 'gamesStarted')}`,
    ];
    log(`  DIGEST ${D} ${gid} ${parts.join(' ')}`);
  }
}
log(`\nPROBE 4 DONE: ${requests} requests`);
