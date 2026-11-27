/**
 * TEMPORARY diagnostic on the throwaway branch diag/nhl-landing (2026-11-27, run 3). Never merged.
 * Read-only feasibility probe for the Insights data layer: a small number of representative requests
 * (about 30) to verify field names, sample values, pagination and sizes. Writes only to data-raw/.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const SEASON = process.env.SEASON ?? '20262027';
const DATE = process.env.PROBE_DATE ?? '2026-11-25';
const REST = 'https://api.nhle.com/stats/rest/en';
const WEB = 'https://api-web.nhle.com/v1';
const RAW = 'data-raw/stats-probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);
let requests = 0;

async function get(url) {
  requests++;
  const t = Date.now();
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'fantasy-playoff-optimizer insights feasibility probe' } });
    const text = await res.text();
    await sleep(250);
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, bytes: text.length, ms: Date.now() - t, body };
  } catch (e) {
    return { status: 0, bytes: 0, ms: Date.now() - t, error: String(e) };
  }
}
const short = (v, n = 1200) => { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
const restUrl = (path, { game = false, cayenne, limit = 100, start = 0, sort = 'playerId' } = {}) => {
  const p = new URLSearchParams({ isAggregate: 'false', isGame: String(game), start: String(start), limit: String(limit), sort: JSON.stringify([{ property: sort, direction: 'ASC' }]), cayenneExp: cayenne });
  return `${REST}/${path}?${p}`;
};
const seasonExp = `gameTypeId=2 and seasonId<=${SEASON} and seasonId>=${SEASON}`;
const dateExp = `gameTypeId=2 and gameDate<="${DATE} 23:59:59" and gameDate>="${DATE}"`;

/** Fetch a REST report, log status/size/total/keys/sample; returns rows. */
async function rest(label, path, opts) {
  const r = await get(restUrl(path, opts));
  const rows = Array.isArray(r.body?.data) ? r.body.data : [];
  log(`\n=== ${label}: ${path} isGame=${opts.game ?? false} | HTTP ${r.status} | ${r.bytes} bytes | ${r.ms} ms | total ${r.body?.total ?? '-'} | rows ${rows.length}${r.error ? ' | ERROR ' + r.error : ''}${!rows.length && r.body ? ' | body ' + short(r.body, 300) : ''}`);
  if (rows[0]) {
    log(`  fields: ${Object.keys(rows[0]).join(', ')}`);
    log(`  sample: ${short(rows[0])}`);
  }
  await writeFile(`${RAW}/${label.replace(/\W+/g, '_')}.json`, JSON.stringify(r.body ?? null));
  return rows;
}

await mkdir(RAW, { recursive: true });
const schedule = JSON.parse(await readFile('public/data/schedule.json', 'utf8'));
const games = schedule.games.filter((g) => g.date === DATE);
log(`PROBE: season ${SEASON}, date ${DATE}, scheduled games that day ${games.length}`);

// 1. Per-game skater rows via isGame=true for one date (league-wide, paginated).
const sumGame = [];
for (let start = 0; start < 1000; start += 100) {
  const rows = await rest(`skater summary isGame page ${start / 100}`, 'skater/summary', { game: true, cayenne: dateExp, start });
  sumGame.push(...rows);
  if (rows.length < 100) break;
}
const ids = new Set(sumGame.map((r) => `${r.playerId}|${r.gameId}`));
log(`  isGame summary for ${DATE}: ${sumGame.length} rows, ${ids.size} distinct player-games, ${new Set(sumGame.map((r) => r.gameId)).size} distinct gameIds`);
const rtGame = await rest('skater realtime isGame', 'skater/realtime', { game: true, cayenne: dateExp, limit: 100 });
const toiGame = await rest('skater timeonice isGame', 'skater/timeonice', { game: true, cayenne: dateExp, limit: 100 });
const ppGame = await rest('skater powerplay isGame', 'skater/powerplay', { game: true, cayenne: dateExp, limit: 100 });
const spgGame = await rest('skater scoringpergame isGame', 'skater/scoringpergame', { game: true, cayenne: dateExp, limit: 5 });

// 2–4. Season-level skater reports (one page each, to see fields).
await rest('skater timeonice season', 'skater/timeonice', { cayenne: seasonExp, limit: 5 });
await rest('skater powerplay season', 'skater/powerplay', { cayenne: seasonExp, limit: 5 });
await rest('skater scoringpergame season', 'skater/scoringpergame', { cayenne: seasonExp, limit: 5 });
await rest('skater scoringRates season', 'skater/scoringRates', { cayenne: seasonExp, limit: 5 });

// 3. Team context: season and one date.
const teamSeason = await rest('team summary season', 'team/summary', { cayenne: seasonExp, limit: 50, sort: 'teamId' });
const teamPpSeason = await rest('team powerplay season', 'team/powerplay', { cayenne: seasonExp, limit: 50, sort: 'teamId' });
const teamPpGame = await rest('team powerplay isGame', 'team/powerplay', { game: true, cayenne: dateExp, limit: 100, sort: 'teamId' });
await rest('team summary isGame', 'team/summary', { game: true, cayenne: dateExp, limit: 5, sort: 'teamId' });

// 5. Goalies.
const gSumGame = await rest('goalie summary isGame', 'goalie/summary', { game: true, cayenne: dateExp, limit: 100 });
await rest('goalie summary season', 'goalie/summary', { cayenne: seasonExp, limit: 5 });
await rest('goalie advanced season', 'goalie/advanced', { cayenne: seasonExp, limit: 5 });
await rest('goalie startedVsRelieved season', 'goalie/startedVsRelieved', { cayenne: seasonExp, limit: 5 });
await rest('goalie daysrest season', 'goalie/daysrest', { cayenne: seasonExp, limit: 5 });

// Gamecenter boxscore and play-by-play for one game; a player game log for comparison.
const g = games[0];
let box;
if (g) {
  const r = await get(`${WEB}/gamecenter/${g.id}/boxscore`);
  box = r.body;
  log(`\n=== boxscore ${g.id} (${g.away}@${g.home}) | HTTP ${r.status} | ${r.bytes} bytes | top-level: ${box ? Object.keys(box).join(', ') : '-'}`);
  const pbs = box?.playerByGameStats;
  if (pbs) {
    log(`  playerByGameStats: ${Object.keys(pbs).join(', ')}; homeTeam groups: ${Object.keys(pbs.homeTeam ?? {}).join(', ')}`);
    for (const grp of ['forwards', 'defense', 'goalies']) {
      const list = pbs.homeTeam?.[grp] ?? [];
      log(`  homeTeam.${grp}: ${list.length} players; fields: ${list[0] ? Object.keys(list[0]).join(', ') : '-'}`);
      if (list[0]) log(`    sample: ${short(list[0], 900)}`);
    }
  }
  const other = box ? Object.keys(box).filter((k) => !['playerByGameStats'].includes(k)) : [];
  log(`  team-level blocks: ${other.map((k) => `${k}=${typeof box[k] === 'object' ? short(box[k], 160) : box[k]}`).join(' | ').slice(0, 1500)}`);
  await writeFile(`${RAW}/boxscore.json`, JSON.stringify(box ?? null));

  const p = await get(`${WEB}/gamecenter/${g.id}/play-by-play`);
  const plays = Array.isArray(p.body?.plays) ? p.body.plays : [];
  const goals = plays.filter((x) => x.typeDescKey === 'goal');
  log(`\n=== play-by-play ${g.id} | HTTP ${p.status} | ${p.bytes} bytes | plays ${plays.length} | goals ${goals.length}`);
  if (goals[0]) log(`  goal sample: ${short(goals[0], 900)}`);
  const shot = plays.find((x) => x.typeDescKey === 'shot-on-goal');
  if (shot) log(`  shot sample: ${short(shot, 600)}`);
  const pen = plays.find((x) => x.typeDescKey === 'penalty');
  if (pen) log(`  penalty sample: ${short(pen, 500)}`);

  // Cross-check: same player's game line in isGame summary vs boxscore.
  const boxPlayers = ['forwards', 'defense'].flatMap((grp) => [...(box?.playerByGameStats?.homeTeam?.[grp] ?? []), ...(box?.playerByGameStats?.awayTeam?.[grp] ?? [])]);
  const gameRows = sumGame.filter((r) => String(r.gameId) === String(g.id));
  log(`\n=== CROSS-CHECK game ${g.id}: boxscore skaters ${boxPlayers.length}, isGame summary rows ${gameRows.length}`);
  let mism = 0;
  for (const bp of boxPlayers.slice(0, 40)) {
    const row = gameRows.find((r) => r.playerId === bp.playerId);
    if (!row) { mism++; log(`  no isGame row for ${bp.playerId}`); continue; }
    const pairs = [['goals', bp.goals, row.goals], ['assists', bp.assists, row.assists], ['points', bp.points, row.points], ['shots', bp.sog ?? bp.shots, row.shots], ['plusMinus', bp.plusMinus, row.plusMinus], ['pim', bp.pim, row.penaltyMinutes]];
    const bad = pairs.filter(([, a, b]) => a !== undefined && b !== undefined && a !== b);
    if (bad.length) { mism++; log(`  mismatch ${bp.playerId}: ${JSON.stringify(bad)}`); }
  }
  log(`  players compared ${Math.min(40, boxPlayers.length)}, mismatches ${mism}`);
  const one = boxPlayers[0];
  if (one) {
    const t = toiGame.find((r) => r.playerId === one.playerId && String(r.gameId) === String(g.id));
    const pp = ppGame.find((r) => r.playerId === one.playerId && String(r.gameId) === String(g.id));
    log(`  TOI check ${one.playerId}: boxscore toi ${one.toi} | timeonice row ${short(t ?? 'not on first page', 500)} | powerplay row ${short(pp ?? 'not on first page', 500)}`);
  }
  // PP share denominator check: team PP time for this game vs players' PP TOI.
  const teamRows = teamPpGame.filter((r) => String(r.gameId) === String(g.id));
  log(`  team powerplay isGame rows for game: ${short(teamRows, 900)}`);
  const ppRowsGame = ppGame.filter((r) => String(r.gameId) === String(g.id));
  log(`  skater powerplay isGame rows for game on first page: ${ppRowsGame.length}`);
  // Goalie cross-check.
  const gb = [...(box?.playerByGameStats?.homeTeam?.goalies ?? []), ...(box?.playerByGameStats?.awayTeam?.goalies ?? [])];
  log(`  goalies in boxscore: ${short(gb.map((x) => ({ id: x.playerId, starter: x.starter, toi: x.toi, saves: x.saves, sa: x.shotsAgainst, ga: x.goalsAgainst, pct: x.savePctg, decision: x.decision })), 600)}`);
  log(`  goalie isGame rows for game: ${short(gSumGame.filter((r) => String(r.gameId) === String(g.id)), 900)}`);

  const pid = boxPlayers[0]?.playerId;
  if (pid) {
    const gl = await get(`${WEB}/player/${pid}/game-log/${SEASON}/2`);
    const list = gl.body?.gameLog ?? [];
    log(`\n=== player game-log ${pid} | HTTP ${gl.status} | ${gl.bytes} bytes | top-level ${gl.body ? Object.keys(gl.body).join(', ') : '-'} | games ${list.length}`);
    if (list[0]) log(`  fields: ${Object.keys(list[0]).join(', ')}\n  sample: ${short(list[0], 700)}`);
  }
}
log(`\nPROBE DONE: ${requests} requests; team season rows ${teamSeason.length}, team pp season rows ${teamPpSeason.length}, realtime isGame rows ${rtGame.length}, scoringpergame isGame rows ${spgGame.length}`);
