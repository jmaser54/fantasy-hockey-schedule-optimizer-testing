/**
 * NHL Stats REST per-game reports for Insights (verified 2026-11-27, docs/PROJECT_SOURCE_OF_TRUTH.md §J):
 * isGame=true gives one row per player per game; a date range must be sorted by gameId then playerId
 * (playerId alone duplicated and skipped rows); pages hold at most 100 rows. Every field we use is
 * checked; a missing value stays null and never becomes 0.
 */
import { STATS_BASE } from './stats.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export type GetJson = (url: string) => Promise<unknown>;

export const PAGE = 100;
const MAX_PAGES = 200;

/** Skater line: team, g, a, a1, a2, pts, evPts, ppp, sog, hit, blk, pim, pm, toi, evToi, ppToi, shToi, evG, ppG, shp. */
export type SkaterLine = [string, ...(number | null)[]];
/** Goalie line: team, gs, sv, sa, ga, toi, result ("W" | "L" | "OTL" | null). */
export type GoalieLine = [string, number, number, number, number, number, 'W' | 'L' | 'OTL' | null];
export const SKATER_FIELDS = ['g', 'a', 'a1', 'a2', 'pts', 'evPts', 'ppp', 'sog', 'hit', 'blk', 'pim', 'pm', 'toi', 'evToi', 'ppToi', 'shToi', 'evG', 'ppG', 'shp'] as const;

export interface TeamGame {
  home: boolean;
  gf: number | null;
  sf: number | null;
  ppOpp: number | null;
  ppGoals: number | null;
  ppToi: number | null;
}
export interface GameRecord {
  date: string;
  teamIds: Record<string, number>;
  teams: Record<string, TeamGame>;
  skaters: Record<string, SkaterLine>;
  goalies: Record<string, GoalieLine>;
}

export const GAME_REPORTS = {
  summary: { path: 'skater/summary', sort: ['gameId', 'playerId'] },
  scoring: { path: 'skater/scoringpergame', sort: ['gameId', 'playerId'] },
  toi: { path: 'skater/timeonice', sort: ['gameId', 'playerId'] },
  teamPp: { path: 'team/powerplay', sort: ['gameId', 'teamId'] },
  teamSum: { path: 'team/summary', sort: ['gameId', 'teamId'] },
  goalie: { path: 'goalie/summary', sort: ['gameId', 'playerId'] },
} as const;
export type GameReport = keyof typeof GAME_REPORTS;

export function rangeUrl(report: GameReport, from: string, to: string, start: number): string {
  const r = GAME_REPORTS[report];
  const p = new URLSearchParams({
    isAggregate: 'false',
    isGame: 'true',
    start: String(start),
    limit: String(PAGE),
    sort: JSON.stringify(r.sort.map((property) => ({ property, direction: 'ASC' }))),
    cayenneExp: `gameTypeId=2 and gameDate<="${to} 23:59:59" and gameDate>="${from}"`,
  });
  return `${STATS_BASE}/${r.path}?${p}`;
}

/** Fetch every page of a per-game report for a date range. Throws unless exactly `total` distinct rows came back. */
export async function fetchRange(getJson: GetJson, report: GameReport, from: string, to: string): Promise<Json[]> {
  const rows: Json[] = [];
  let total: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson(rangeUrl(report, from, to, page * PAGE));
    if (!isObj(body) || !Array.isArray(body.data) || !Number.isInteger(body.total)) throw new Error(`${report}: response has no data array or integer total`);
    if (total === undefined) total = body.total as number;
    else if (body.total !== total) throw new Error(`${report}: total changed during paging (${total} → ${String(body.total)})`);
    for (const r of body.data) {
      if (!isObj(r)) throw new Error(`${report}: row is not an object`);
      rows.push(r);
    }
    if (body.data.length < PAGE || rows.length >= total) break;
  }
  if (rows.length !== total) throw new Error(`${report}: ${rows.length} rows for total ${total}`);
  const second = GAME_REPORTS[report].sort[1];
  const keys = new Set(rows.map((r) => `${String(r.gameId)}|${String(r[second])}`));
  if (keys.size !== rows.length) throw new Error(`${report}: ${rows.length - keys.size} duplicate rows`);
  for (const r of rows) {
    const d = r.gameDate;
    if (typeof d !== 'string' || d.slice(0, 10) < from || d.slice(0, 10) > to) throw new Error(`${report}: row dated ${String(d)} outside ${from}..${to}`);
  }
  return rows;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

export interface AssembleResult {
  games: Map<string, GameRecord>;
  rejected: { gameId: string; reason: string }[];
}

/**
 * Join the six per-game reports into game records and validate each game. A game that fails any check
 * is rejected (and retried by a later run); the others are returned.
 */
export function assembleGames(rows: Record<GameReport, Json[]>): AssembleResult {
  const byGame = (list: Json[]) => {
    const m = new Map<string, Json[]>();
    for (const r of list) {
      const g = String(r.gameId);
      m.set(g, [...(m.get(g) ?? []), r]);
    }
    return m;
  };
  const sum = byGame(rows.summary);
  const scoring = byGame(rows.scoring);
  const toi = byGame(rows.toi);
  const teamPp = byGame(rows.teamPp);
  const teamSum = byGame(rows.teamSum);
  const goalie = byGame(rows.goalie);
  const games = new Map<string, GameRecord>();
  const rejected: AssembleResult['rejected'] = [];
  const allIds = new Set([...sum.keys(), ...teamPp.keys(), ...goalie.keys()]);
  for (const gameId of [...allIds].sort()) {
    const reject = (reason: string) => rejected.push({ gameId, reason });
    if (!/^\d{10}$/.test(gameId) || gameId.slice(4, 6) !== '02') { reject('not a regular-season game id'); continue; }
    const s = sum.get(gameId) ?? [];
    const date = typeof s[0]?.gameDate === 'string' ? (s[0].gameDate as string).slice(0, 10) : '';
    const sc = new Map((scoring.get(gameId) ?? []).map((r) => [String(r.playerId), r]));
    const ti = new Map((toi.get(gameId) ?? []).map((r) => [String(r.playerId), r]));
    const tp = teamPp.get(gameId) ?? [];
    const ts = teamSum.get(gameId) ?? [];
    const gl = goalie.get(gameId) ?? [];
    const teams = [...new Set(s.map((r) => r.teamAbbrev))];
    if (teams.length !== 2 || teams.some((t) => typeof t !== 'string' || !/^[A-Z]{3}$/.test(t as string))) { reject(`skater teams ${JSON.stringify(teams)}`); continue; }
    if (sc.size !== s.length || ti.size !== s.length || s.some((r) => !sc.has(String(r.playerId)) || !ti.has(String(r.playerId)))) { reject('skater reports cover different players'); continue; }
    if (tp.length !== 2 || ts.length !== 2) { reject(`team rows: powerplay ${tp.length}, summary ${ts.length}`); continue; }
    const counts = teams.map((t) => s.filter((r) => r.teamAbbrev === t).length);
    if (counts.some((c) => c < 15 || c > 21)) { reject(`skaters per team ${counts}`); continue; }
    // Team rows carry teamId but no abbreviation: join on homeRoad, which skater rows also carry.
    const teamOf = (homeRoad: unknown) => {
      const t = new Set(s.filter((r) => r.homeRoad === homeRoad).map((r) => r.teamAbbrev));
      return t.size === 1 ? (String([...t][0])) : undefined;
    };
    const rec: GameRecord = { date, teamIds: {}, teams: {}, skaters: {}, goalies: {} };
    let bad = '';
    for (const hr of ['H', 'R']) {
      const t = teamOf(hr);
      const p = tp.find((r) => r.homeRoad === hr);
      const q = ts.find((r) => r.homeRoad === hr);
      if (!t || !p || !q || p.teamId !== q.teamId || int(p.teamId) === null) { bad = `cannot join team rows for ${hr}`; break; }
      rec.teamIds[t] = p.teamId as number;
      rec.teams[t] = { home: hr === 'H', gf: int(q.goalsFor), sf: int(q.shotsForPerGame), ppOpp: int(p.ppOpportunities), ppGoals: int(p.powerPlayGoalsFor), ppToi: int(p.ppTimeOnIcePerGame) };
    }
    if (bad) { reject(bad); continue; }
    for (const r of s) {
      const id = String(r.playerId);
      const c = sc.get(id)!;
      const t = ti.get(id)!;
      if (r.gamesPlayed !== 1 || c.gamesPlayed !== 1 || t.gamesPlayed !== 1) { bad = `player ${id} gamesPlayed not 1`; break; }
      if (num(r.goals) !== num(c.goals)) { bad = `player ${id} goals differ between reports`; break; }
      const line: SkaterLine = [
        String(r.teamAbbrev),
        int(r.goals), int(r.assists), int(c.totalPrimaryAssists), int(c.totalSecondaryAssists), int(r.points), int(r.evPoints), int(r.ppPoints),
        int(r.shots), int(c.hits), int(c.blockedShots), int(r.penaltyMinutes), int(r.plusMinus),
        int(t.timeOnIce), int(t.evTimeOnIce), int(t.ppTimeOnIce), int(t.shTimeOnIce),
        int(r.evGoals), int(r.ppGoals), int(r.shPoints),
      ];
      const teamPpToi = rec.teams[line[0]]?.ppToi;
      const ppToi = line[15];
      if (typeof ppToi === 'number' && typeof teamPpToi === 'number' && ppToi > teamPpToi + 5) { bad = `player ${id} PP time above team PP time`; break; }
      rec.skaters[id] = line;
    }
    if (bad) { reject(bad); continue; }
    for (const t of teams as string[]) {
      const lines = Object.values(rec.skaters).filter((l) => l[0] === t);
      const totalToi = lines.reduce((a, l) => a + (l[13] ?? 0), 0);
      if (totalToi < 15000 || totalToi > 23000) { bad = `${t} skater ice time total implausible`; break; }
      const goals = lines.reduce((a, l) => a + (l[1] ?? 0), 0);
      const gf = rec.teams[t]!.gf;
      if (gf !== null && (gf - goals < 0 || gf - goals > 1)) { bad = `${t} skater goals do not match team goals`; break; }
    }
    if (bad) { reject(bad); continue; }
    for (const r of gl) {
      const t = String(r.teamAbbrev);
      if (!rec.teams[t]) { bad = `goalie ${String(r.playerId)} team ${t} not in game`; break; }
      const gs = int(r.gamesStarted), sv = int(r.saves), sa = int(r.shotsAgainst), ga = int(r.goalsAgainst), gtoi = int(r.timeOnIce);
      if (gs === null || sv === null || sa === null || ga === null || gtoi === null) { bad = `goalie ${String(r.playerId)} has missing values`; break; }
      const result = r.wins === 1 ? 'W' : r.losses === 1 ? 'L' : r.otLosses === 1 ? 'OTL' : null;
      rec.goalies[String(r.playerId)] = [t, gs, sv, sa, ga, gtoi, result];
    }
    if (bad) { reject(bad); continue; }
    const starts = (teams as string[]).map((t) => Object.values(rec.goalies).filter((g) => g[0] === t).reduce((a, g) => a + g[1], 0));
    if (starts.some((n) => n !== 1)) { reject(`goalie starts per team ${starts}`); continue; }
    games.set(gameId, rec);
  }
  return { games, rejected };
}
