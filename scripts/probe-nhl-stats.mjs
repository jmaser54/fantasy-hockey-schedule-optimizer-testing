/**
 * TEMPORARY diagnostic on the throwaway branch diag/nhl-landing (2026-11-27). Never merged.
 * Read-only: checks whether the NHL player landing endpoint distinguishes current NHL players,
 * injured players absent from the current-roster feed, and players assigned elsewhere.
 * Run 2 population: players with NHL games this season (skaters from skater-stats.json, goalies from
 * the NHL goalie summary report) who are on no current roster. At most 76 profile requests (run 1 used 24).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const SEASON = process.env.SEASON ?? '20262027';
const BASE = 'https://api-web.nhle.com/v1';
const RAW = 'data-raw/stats-probe';
const MAX_PROFILES = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

async function get(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json', 'user-agent': 'fantasy-playoff-optimizer roster-status probe' } });
      if (res.status === 404) return { status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, body: await res.json() };
    } catch (e) {
      if (i === 2) return { status: 0, error: String(e) };
      await sleep(2000);
    } finally {
      await sleep(150);
    }
  }
}
const name = (p) => `${p.firstName?.default ?? ''} ${p.lastName?.default ?? ''}`.trim();
const rosterIds = (body) => ['forwards', 'defensemen', 'goalies'].flatMap((g) => (Array.isArray(body?.[g]) ? body[g] : []).map((p) => ({ id: p.id, name: name(p), pos: p.positionCode })));

await mkdir(RAW, { recursive: true });
const teams = JSON.parse(await readFile('public/data/schedule.json', 'utf8')).teams.map((t) => t.id);
const dir = JSON.parse(await readFile('public/data/players.json', 'utf8')).players;
const dirByNhl = new Map(dir.filter((p) => p.nhlId).map((p) => [p.nhlId, p]));

const current = new Map(); // id -> {team, ...}
let rosterRequests = 0;
for (const t of teams) {
  const c = await get(`/roster/${t}/current`); rosterRequests++;
  if (!c.body) log(`roster fetch problem ${t}: ${c.status} ${c.error ?? ''}`);
  for (const p of rosterIds(c.body)) current.set(p.id, { ...p, team: t });
}
// Players with NHL games this season: skaters from the bundled stats file, goalies from one NHL stats request.
const skaters = JSON.parse(await readFile('public/data/skater-stats.json', 'utf8')).skaters;
const goalies = [];
for (let start = 0; start < 400; start += 100) {
  const u = `https://api.nhle.com/stats/rest/en/goalie/summary?isAggregate=false&isGame=false&start=${start}&limit=100&sort=playerId&cayenneExp=gameTypeId=2%20and%20seasonId=${SEASON}`;
  const res = await fetch(u, { headers: { accept: 'application/json' } }); await sleep(150);
  const j = res.ok ? await res.json() : { data: [] };
  goalies.push(...(j.data ?? []));
  if ((j.data ?? []).length < 100) break;
}
const offFeed = [
  ...goalies.filter((g) => !current.has(g.playerId)).map((g) => ({ id: g.playerId, name: g.goalieFullName, pos: 'G', team: g.teamAbbrevs, nhlGpStats: g.gamesPlayed })),
  ...skaters.filter((s) => !current.has(s.nhlId)).map((s) => ({ id: s.nhlId, name: s.name, pos: s.position, team: (s.teams ?? []).join('/'), nhlGpStats: s.gamesPlayed })),
];
log(`ROSTER PROBE: ${rosterRequests} current-roster requests; current-roster players ${current.size}; goalies with ${SEASON} NHL games ${goalies.length}; NHL players with ${SEASON} games but on no current roster: ${offFeed.length} (goalies ${offFeed.filter((p) => p.pos === 'G').length}, skaters ${offFeed.filter((p) => p.pos !== 'G').length})`);
const MAX_THIS_RUN = 76; // the first run used 24 profile requests
const targets = offFeed.slice(0, MAX_THIS_RUN).map((p) => ({ ...p, group: 'off-feed' }));
log(`PROFILE PROBE: ${targets.length} profile requests (off-feed players; ${Math.max(0, offFeed.length - targets.length)} not checked because of the cap)`);

const keyCount = {};
const rows = [];
let saved = 0;
for (const p of targets) {
  const r = await get(`/player/${p.id}/landing`);
  if (!r.body) { rows.push({ ...p, error: `${r.status} ${r.error ?? ''}` }); continue; }
  const b = r.body;
  for (const k of Object.keys(b)) keyCount[k] = (keyCount[k] ?? 0) + 1;
  if (saved < 6 && (p.group === 'current' || saved < 4)) { await writeFile(`${RAW}/landing-${p.group}-${p.id}.json`, JSON.stringify(b, null, 2)); saved++; }
  const totals = Array.isArray(b.seasonTotals) ? b.seasonTotals.filter((x) => String(x.season) === SEASON) : [];
  const lines = totals.map((x) => `${x.leagueAbbrev}:${x.teamName?.default ?? x.teamCommonName?.default ?? '?'} gt${x.gameTypeId} gp${x.gamesPlayed}`);
  const last5 = Array.isArray(b.last5Games) ? b.last5Games.map((g) => g.gameDate).filter(Boolean) : [];
  const d = dirByNhl.get(p.id);
  rows.push({
    ...p,
    isActive: b.isActive,
    currentTeamId: b.currentTeamId,
    currentTeamAbbrev: b.currentTeamAbbrev,
    statusLike: Object.fromEntries(Object.entries(b).filter(([k]) => /status|injur|roster|assign|transac|reserve|active/i.test(k)).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : v])),
    lines,
    nhlGp: totals.filter((x) => x.leagueAbbrev === 'NHL').reduce((a, x) => a + (x.gamesPlayed ?? 0), 0),
    otherGp: totals.filter((x) => x.leagueAbbrev !== 'NHL').reduce((a, x) => a + (x.gamesPlayed ?? 0), 0),
    otherLeagues: [...new Set(totals.filter((x) => x.leagueAbbrev !== 'NHL').map((x) => x.leagueAbbrev))],
    lastNhlGame: last5[0],
    inOwnCurrentTeamRoster: Array.isArray(b.currentTeamRoster) ? b.currentTeamRoster.some((x) => x.playerId === p.id) : 'n/a',
    directory: d ? (d.inactive ? 'inactive' : 'active') : 'no nhlId in directory',
  });
}
await writeFile(`${RAW}/landing-summary.json`, JSON.stringify(rows, null, 2));

log(`LANDING FIELDS (profiles having each): ${JSON.stringify(keyCount)}`);
log(`LANDING status-like fields seen: ${JSON.stringify([...new Set(rows.flatMap((r) => Object.keys(r.statusLike ?? {})))])}`);
const tab = {};
for (const r of rows) {
  const k = `${r.pos === 'G' ? 'G' : 'S'}|isActive=${r.isActive}|currentTeam=${r.currentTeamAbbrev ? 'XXX' + (String(r.team).split(/[\/,]/).includes(r.currentTeamAbbrev) ? '(a team he played for)' : '(other)') : 'none'}|AHL/other league ${SEASON}=${r.otherGp > 0 ? 'yes' : 'no'}|in currentTeamRoster=${r.inOwnCurrentTeamRoster}`;
  tab[k] = (tab[k] ?? 0) + 1;
}
for (const [k, v] of Object.entries(tab).sort()) log(`LANDING CROSSTAB ${k}: ${v}`);
for (const r of rows) {
  log(`LANDING ${r.group} ${r.pos} ${r.name} (${r.id}) season-team ${r.team} | ${r.error ? 'ERROR ' + r.error : `isActive=${r.isActive} currentTeam=${r.currentTeamAbbrev ?? r.currentTeamId ?? 'none'} | ${SEASON}: ${r.lines.join(', ') || 'no season lines'} | NHL GP (stats) ${r.nhlGpStats} | last NHL game ${r.lastNhlGame ?? '-'} | in currentTeamRoster ${r.inOwnCurrentTeamRoster} | directory ${r.directory}`}`);
}
