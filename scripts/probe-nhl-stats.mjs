/**
 * TEMPORARY diagnostic on the throwaway branch diag/nhl-landing (2026-11-27). Never merged.
 * Read-only: checks whether the NHL player landing endpoint distinguishes current NHL players,
 * injured players absent from the current-roster feed, and players assigned elsewhere.
 * Population: players on a team's season roster but on no current roster ("dropped"),
 * skaters and goalies, plus a control sample of current-roster players. At most 100 profile requests.
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
const season = new Map(); // id -> {teams:[], ...}
let rosterRequests = 0;
for (const t of teams) {
  const c = await get(`/roster/${t}/current`); rosterRequests++;
  const s = await get(`/roster/${t}/${SEASON}`); rosterRequests++;
  if (!c.body || !s.body) log(`roster fetch problem ${t}: current ${c.status} ${c.error ?? ''} season ${s.status} ${s.error ?? ''}`);
  for (const p of rosterIds(c.body)) current.set(p.id, { ...p, team: t });
  for (const p of rosterIds(s.body)) {
    const e = season.get(p.id) ?? { ...p, teams: [] };
    e.teams.push(t);
    season.set(p.id, e);
  }
}
const dropped = [...season.values()].filter((p) => !current.has(p.id));
log(`ROSTER PROBE: ${rosterRequests} roster requests; current-roster players ${current.size}; season-roster players ${season.size}; on a season roster but no current roster ${dropped.length} (goalies ${dropped.filter((p) => p.pos === 'G').length})`);

// Profiles: all dropped goalies, then dropped skaters, then controls (current players, incl. goalies, spread over teams).
const droppedSorted = [...dropped.filter((p) => p.pos === 'G'), ...dropped.filter((p) => p.pos !== 'G')];
const curList = [...current.values()];
const controls = [
  ...teams.slice(0, 8).map((t) => curList.find((p) => p.team === t && p.pos === 'G')),
  ...teams.slice(8, 24).map((t) => curList.find((p) => p.team === t && p.pos !== 'G')),
].filter(Boolean);
const budgetDropped = Math.min(droppedSorted.length, MAX_PROFILES - controls.length);
const targets = [...droppedSorted.slice(0, budgetDropped).map((p) => ({ ...p, group: 'dropped', team: p.teams.join('/') })), ...controls.map((p) => ({ ...p, group: 'current' }))];
log(`PROFILE PROBE: ${targets.length} profile requests (dropped ${budgetDropped} of ${dropped.length}, current controls ${controls.length})`);

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
    directory: d ? (d.inactive ? 'inactive' : 'active') : 'no nhlId in directory',
  });
}
await writeFile(`${RAW}/landing-summary.json`, JSON.stringify(rows, null, 2));

log(`LANDING FIELDS (profiles having each): ${JSON.stringify(keyCount)}`);
log(`LANDING status-like fields seen: ${JSON.stringify([...new Set(rows.flatMap((r) => Object.keys(r.statusLike ?? {})))])}`);
const tab = {};
for (const r of rows) {
  const k = `${r.group}|${r.pos === 'G' ? 'G' : 'S'}|isActive=${r.isActive}|currentTeam=${r.currentTeamAbbrev ?? (r.currentTeamId ? 'id' + r.currentTeamId : 'none')}${r.group === 'dropped' ? (r.team.split('/').includes(r.currentTeamAbbrev) ? '(same as season roster)' : '(different/none)') : r.currentTeamAbbrev === r.team ? '(same)' : '(different/none)'}|otherLeague2627=${r.otherGp > 0 ? 'yes' : 'no'}`;
  tab[k.replace(/currentTeam=[A-Z]{3}/, 'currentTeam=XXX')] = (tab[k.replace(/currentTeam=[A-Z]{3}/, 'currentTeam=XXX')] ?? 0) + 1;
}
for (const [k, v] of Object.entries(tab).sort()) log(`LANDING CROSSTAB ${k}: ${v}`);
for (const r of rows) {
  log(`LANDING ${r.group} ${r.pos} ${r.name} (${r.id}) season-team ${r.team} | ${r.error ? 'ERROR ' + r.error : `isActive=${r.isActive} currentTeam=${r.currentTeamAbbrev ?? r.currentTeamId ?? 'none'} | ${SEASON}: ${r.lines.join(', ') || 'no season lines'} | last NHL game ${r.lastNhlGame ?? '-'} | status-like ${JSON.stringify(r.statusLike)} | directory ${r.directory}`}`);
}
