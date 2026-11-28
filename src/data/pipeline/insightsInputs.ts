/**
 * Season baselines (NHL Stats REST season reports) and the published Insights inputs
 * (public/data/insights-inputs.json): last-5 / last-10 windows from the private game window, season
 * blocks from the season reports, Talent and Opportunity kept apart, current NHL roster players only.
 */
import { INSIGHTS_VERSION, type GoalieWindow, type InsightsInputsFile, type PlayersFile, type SkaterStatsFile, type SkaterWindow, type TalentEvidence } from '../format.ts';
import { validateInsightsInputs } from '../validate.ts';
import type { GetJson, SkaterLine } from './gamelog.ts';
import { goalieStartFacts, posGroup, positionRates, skaterFeatures, type SeasonTotals, type WindowAppearance } from './insightsFeatures.ts';
import { buildSequence, fitParticipation, playerParticipation } from './participation.ts';
import { teamOnDate } from '../../domain/schedule.ts';
import type { InsightsConfig, WindowState } from './insightsWindow.ts';
import { STATS_BASE } from './stats.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

export interface SeasonData {
  fetchedAt: string;
  skaters: Record<string, { gp: number; g: number | null; a: number | null; a1: number | null; a2: number | null; pts: number | null; sog: number | null; hit: number | null; blk: number | null; pim: number | null; toi: number | null; evToi: number | null; ppToi: number | null; shToi: number | null; ppSharePg: number | null; evG?: number | null; ppG?: number | null; shG?: number | null; evPts?: number | null; ppPts?: number | null; shPts?: number | null; pm?: number | null }>;
  /** Keyed by NHL teamId (team reports carry no abbreviation). */
  teams: Record<string, { gp: number; gfPg: number | null; sfPg: number | null; ppPct: number | null; pkPct: number | null; ppOpp: number; ppOppPg: number | null; ppGoals: number; ppToiPg: number | null }>;
  goalies: Record<string, GoalieWindow & { gaa: number | null }>;
}

const seasonUrl = (path: string, season: string, start: number, sort: string) =>
  `${STATS_BASE}/${path}?${new URLSearchParams({
    isAggregate: 'false',
    isGame: 'false',
    start: String(start),
    limit: '100',
    sort: JSON.stringify([{ property: sort, direction: 'ASC' }]),
    cayenneExp: `gameTypeId=2 and seasonId<=${season} and seasonId>=${season}`,
  })}`;

async function fetchSeasonReport(getJson: GetJson, path: string, season: string, sort: string): Promise<Json[]> {
  const rows: Json[] = [];
  let total: number | undefined;
  for (let page = 0; page < 100; page++) {
    const body = await getJson(seasonUrl(path, season, page * 100, sort));
    if (!isObj(body) || !Array.isArray(body.data) || !Number.isInteger(body.total)) throw new Error(`${path}: response has no data array or integer total`);
    if (total === undefined) total = body.total as number;
    else if (body.total !== total) throw new Error(`${path}: total changed during paging`);
    rows.push(...(body.data as Json[]));
    if (body.data.length < 100 || rows.length >= total) break;
  }
  if (rows.length !== total) throw new Error(`${path}: ${rows.length} rows for total ${total}`);
  const ids = new Set(rows.map((r) => String(r[sort])));
  if (ids.size !== rows.length) throw new Error(`${path}: duplicate ${sort}s`);
  for (const r of rows) if (r.seasonId !== Number(season)) throw new Error(`${path}: row for season ${String(r.seasonId)}`);
  return rows;
}

/** Fetch the season reports (about 27 requests) and join them. Throws on any structural problem. */
export async function fetchSeasonData(getJson: GetJson, season: string, nowIso: string): Promise<SeasonData> {
  const scoring = await fetchSeasonReport(getJson, 'skater/scoringpergame', season, 'playerId');
  const toi = new Map((await fetchSeasonReport(getJson, 'skater/timeonice', season, 'playerId')).map((r) => [String(r.playerId), r]));
  const pp = new Map((await fetchSeasonReport(getJson, 'skater/powerplay', season, 'playerId')).map((r) => [String(r.playerId), r]));
  const teamSum = await fetchSeasonReport(getJson, 'team/summary', season, 'teamId');
  const teamPp = new Map((await fetchSeasonReport(getJson, 'team/powerplay', season, 'teamId')).map((r) => [String(r.teamId), r]));
  const goalies = await fetchSeasonReport(getJson, 'goalie/summary', season, 'playerId');
  // Situational goals and points (version 2). Joined leniently: a player missing here keeps nulls.
  const summary = new Map((await fetchSeasonReport(getJson, 'skater/summary', season, 'playerId')).map((r) => [String(r.playerId), r]));
  if (toi.size !== scoring.length || pp.size !== scoring.length) throw new Error(`season skater reports cover different players (${scoring.length}/${toi.size}/${pp.size})`);
  if (teamSum.length !== teamPp.size) throw new Error('season team reports cover different teams');
  const out: SeasonData = { fetchedAt: nowIso, skaters: {}, teams: {}, goalies: {} };
  for (const r of scoring) {
    const id = String(r.playerId);
    const t = toi.get(id);
    const p = pp.get(id);
    if (!t || !p) throw new Error(`season skater ${id} missing from a report`);
    const gp = int(r.gamesPlayed);
    if (gp === null || gp < 1 || t.gamesPlayed !== gp || p.gamesPlayed !== gp) throw new Error(`season skater ${id}: games played differ between reports`);
    out.skaters[id] = {
      gp, g: int(r.goals), a: int(r.assists), a1: int(r.totalPrimaryAssists), a2: int(r.totalSecondaryAssists), pts: int(r.points),
      sog: int(r.shots), hit: int(r.hits), blk: int(r.blockedShots), pim: int(r.penaltyMinutes),
      toi: int(t.timeOnIce), evToi: int(t.evTimeOnIce), ppToi: int(t.ppTimeOnIce), shToi: int(t.shTimeOnIce), ppSharePg: num(p.ppTimeOnIcePctPerGame),
    };
    const u = summary.get(id);
    if (u && u.gamesPlayed === gp) Object.assign(out.skaters[id]!, { evG: int(u.evGoals), ppG: int(u.ppGoals), shG: int(u.shGoals), evPts: int(u.evPoints), ppPts: int(u.ppPoints), shPts: int(u.shPoints), pm: int(u.plusMinus) });
  }
  for (const r of teamSum) {
    const id = String(r.teamId);
    const p = teamPp.get(id)!;
    out.teams[id] = {
      gp: int(r.gamesPlayed) ?? 0, gfPg: num(r.goalsForPerGame), sfPg: num(r.shotsForPerGame), ppPct: num(r.powerPlayPct), pkPct: num(r.penaltyKillPct),
      ppOpp: int(p.ppOpportunities) ?? 0, ppOppPg: num(p.ppOpportunitiesPerGame), ppGoals: int(p.powerPlayGoalsFor) ?? 0, ppToiPg: num(p.ppTimeOnIcePerGame),
    };
  }
  for (const r of goalies) {
    out.goalies[String(r.playerId)] = {
      gp: int(r.gamesPlayed) ?? 0, gs: int(r.gamesStarted) ?? 0, sv: int(r.saves) ?? 0, sa: int(r.shotsAgainst) ?? 0, ga: int(r.goalsAgainst) ?? 0,
      svPct: num(r.savePct), toi: int(r.timeOnIce) ?? 0, w: int(r.wins) ?? 0, l: int(r.losses) ?? 0, otl: int(r.otLosses) ?? 0, gaa: num(r.goalsAgainstAverage),
    };
  }
  return out;
}

const sumOf = (vals: (number | null | undefined)[]): number | null => (vals.some((v) => v === null || v === undefined) ? null : vals.reduce<number>((a, v) => a + (v as number), 0));
const round = (v: number | null, d = 4) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

interface Appearance {
  date: string;
  gameId: string;
  line: SkaterLine;
  teamPpToi: number | null;
}

function skaterWindow(apps: Appearance[], cfg: InsightsConfig): SkaterWindow {
  const f = (i: number) => sumOf(apps.map((x) => x.line[i] as number | null));
  const ppToi = f(15);
  const teamPpToi = sumOf(apps.map((x) => x.teamPpToi));
  return {
    gp: apps.length,
    from: apps[apps.length - 1]!.date,
    to: apps[0]!.date,
    talent: { g: f(1), a: f(2), a1: f(3), a2: f(4), pts: f(5), evPts: f(6), ppp: f(7), sog: f(8), hit: f(9), blk: f(10), pim: f(11), pm: f(12), evG: f(17), ppG: f(18), shp: f(19) },
    opportunity: {
      toi: f(13), evToi: f(14), ppToi, shToi: f(16), teamPpToi,
      ppShare: ppToi !== null && teamPpToi !== null && teamPpToi >= cfg.ppShareMinSeconds ? round(ppToi / teamPpToi) : null,
    },
  };
}

/**
 * Revision of the derived-feature model. Bump it whenever feature calculations change: the refresh
 * rebuilds the published file when the previous one came from another revision, even with no new games.
 */
export const FEATURES_REVISION = '2026-11-28.participation-simplified';

/** Build the published file from the window, season data and the current directory. */
export function buildInsightsInputs(input: {
  state: WindowState;
  season: SeasonData | undefined;
  players: PlayersFile;
  skaterStats: SkaterStatsFile | undefined;
  /** The previous season's reports and skater-stats snapshot: the Talent baseline. */
  previousSeason?: SeasonData;
  previousSkaterStats?: SkaterStatsFile;
  /** The season before that: the baseline when the previous season is too short (2026-11-28). */
  previousSeason2?: SeasonData;
  previousSkaterStats2?: SkaterStatsFile;
  target: readonly string[];
  cfg: InsightsConfig;
  nowIso: string;
}): InsightsInputsFile {
  const { state, season, players, skaterStats, target, cfg, nowIso } = input;
  const complete = target.filter((d) => state.meta.nights[d]?.status === 'complete');
  const gamesThrough = complete.length ? complete[complete.length - 1]! : null;
  const settled = target.slice(0, Math.max(0, target.length - cfg.correctionNights)).filter((d) => state.meta.nights[d]?.status === 'complete');
  // Appearances newest first.
  const skaterApps = new Map<string, Appearance[]>();
  const goalieApps = new Map<string, { date: string; line: (string | number | null)[] }[]>();
  const teamGames = new Map<string, { date: string; gf: number | null; sf: number | null; ppOpp: number | null; ppGoals: number | null; ppToi: number | null }[]>();
  for (const d of Object.keys(state.nights).sort().reverse()) {
    for (const [gameId, g] of Object.entries(state.nights[d]!)) {
      for (const [id, line] of Object.entries(g.skaters)) skaterApps.set(id, [...(skaterApps.get(id) ?? []), { date: d, gameId, line, teamPpToi: g.teams[line[0]]?.ppToi ?? null }]);
      for (const [id, line] of Object.entries(g.goalies)) goalieApps.set(id, [...(goalieApps.get(id) ?? []), { date: d, line }]);
      for (const [t, tg] of Object.entries(g.teams)) teamGames.set(t, [...(teamGames.get(t) ?? []), { date: d, ...tg }]);
    }
  }
  const statsById = new Map((skaterStats?.season === state.meta.season ? skaterStats.skaters : []).map((s) => [String(s.nhlId), s]));
  const prevStatsById = new Map((input.previousSkaterStats?.skaters ?? []).map((s) => [String(s.nhlId), s]));
  const totals = (src: SeasonData | undefined, stats: Map<string, SkaterStatsFile['skaters'][number]>) => {
    const m = new Map<string, SeasonTotals>();
    for (const [id, x] of Object.entries(src?.skaters ?? {})) {
      const st = stats.get(id);
      m.set(id, {
        gp: x.gp, pts: x.pts, g: x.g, evG: x.evG ?? null, ppG: x.ppG ?? null, shG: x.shG ?? null, evPts: x.evPts ?? null, ppPts: x.ppPts ?? null, shPts: x.shPts ?? null,
        sog: x.sog, hit: x.hit, blk: x.blk, pim: x.pim, pm: x.pm ?? null, fow: st && st.gamesPlayed === x.gp && typeof st.faceoffWins === 'number' ? st.faceoffWins : null,
        toi: x.toi, evToi: x.evToi, ppToi: x.ppToi, shToi: x.shToi, ppSharePg: x.ppSharePg,
      });
    }
    return m;
  };
  const cur = totals(season, statsById);
  const prev = totals(input.previousSeason, prevStatsById);
  const prev2 = totals(input.previousSeason2, new Map((input.previousSkaterStats2?.skaters ?? []).map((s) => [String(s.nhlId), s])));
  const groupOfStat = (s: SkaterStatsFile['skaters'][number] | undefined) => (s ? (s.position === 'D' ? 'D' : 'F') : undefined);
  const pool = (m: Map<string, SeasonTotals>, stats: Map<string, SkaterStatsFile['skaters'][number]>) =>
    [...m.entries()].flatMap(([id, t]) => {
      const g = groupOfStat(stats.get(id));
      return g ? [[t, g] as [SeasonTotals, 'F' | 'D']] : [];
    });
  const prevPool = pool(prev, prevStatsById);
  const posAvg = prevPool.length ? positionRates(prevPool, 20) : positionRates(pool(cur, statsById), 10);
  const posMinutes = (['F', 'D'] as const).map((g) => {
    const list = pool(cur, statsById).filter(([t, gg]) => gg === g && t.gp >= 10);
    const avg = (f: (t: SeasonTotals) => number | null, def: number) => {
      const v = list.map(([t]) => f(t)).filter((x): x is number => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : def;
    };
    return {
      toi: avg((t) => (t.toi === null ? null : t.toi / t.gp / 60), g === 'F' ? 15 : 20),
      evToi: avg((t) => (t.evToi === null ? null : t.evToi / t.gp / 60), g === 'F' ? 12.5 : 16.5),
      shToi: avg((t) => (t.shToi === null ? null : t.shToi / t.gp / 60), g === 'F' ? 0.8 : 1.5),
      ppShare: avg((t) => t.ppSharePg, g === 'F' ? 0.3 : 0.2),
    };
  });
  const teamDates = (team: string) => (teamGames.get(team) ?? []).map((x) => x.date);
  // Participation: each skater's team games (his team on each date) from his first appearance; the model
  // is fitted on every skater's history in the window (current roster or not) and published as aggregates.
  const windowDates = Object.keys(state.nights).sort();
  const teamDateSets = new Map([...teamGames.entries()].map(([t, g]) => [t, new Set(g.map((x) => x.date))]));
  const sequences = new Map<string, boolean[]>();
  for (const p of players.players) {
    if (p.nhlId === undefined || p.positions.includes('G')) continue;
    const apps = skaterApps.get(String(p.nhlId));
    if (!apps?.length) continue;
    const own = windowDates.filter((d) => teamDateSets.get(teamOnDate(p, d))?.has(d));
    sequences.set(String(p.nhlId), buildSequence(own, new Set(apps.map((a) => a.date))));
  }
  const participationModel = fitParticipation([...sequences.values()]);
  const out: InsightsInputsFile = {
    version: INSIGHTS_VERSION,
    season: state.meta.season,
    generatedAt: nowIso,
    gamesThrough,
    settledThrough: settled.length ? settled[settled.length - 1]! : null,
    windowNights: complete.length,
    windowTarget: target.length,
    complete: target.length > 0 && complete.length === target.length,
    settings: { ppShareMinSeconds: cfg.ppShareMinSeconds, correctionNights: cfg.correctionNights, featuresRevision: FEATURES_REVISION },
    sources: {
      gameLogs: 'NHL Stats REST per-game reports (skater summary, scoringpergame, timeonice; team powerplay, summary; goalie summary)',
      season: 'NHL Stats REST season reports (skater scoringpergame, timeonice, powerplay; team summary, powerplay; goalie summary) and skater-stats.json',
      evidence: { talent: true, opportunity: { toi: true, ppShare: true, linemates: false, ppUnit: false, teammateQuality: false } },
    },
    players: {},
    league: { ppToiPg: null },
    participationModel,
    teams: {},
    goalies: {},
  };
  const teamPp = Object.values(season?.teams ?? {}).map((t) => t.ppToiPg).filter((v): v is number => v !== null);
  if (teamPp.length) out.league.ppToiPg = round(teamPp.reduce((a, b) => a + b, 0) / teamPp.length, 1);
  for (const p of players.players) {
    if (p.nhlId === undefined || p.inactive) continue; // Insights candidates: current NHL roster only
    const id = String(p.nhlId);
    const key = `nhl-${id}`;
    if (p.positions.includes('G')) {
      const apps = goalieApps.get(id) ?? [];
      const s = season?.goalies[id];
      if (!apps.length && !s) continue;
      const last = apps.slice(0, 5);
      const lastStart = apps.find((x) => x.line[1] === 1)?.date ?? null;
      const entry: InsightsInputsFile['goalies'][string] = { team: p.team, lastStart };
      if (last.length) {
        const sv = last.reduce((a, x) => a + (x.line[2] as number), 0);
        const sa = last.reduce((a, x) => a + (x.line[3] as number), 0);
        entry.last5 = {
          gp: last.length, gs: last.reduce((a, x) => a + (x.line[1] as number), 0), sv, sa, ga: last.reduce((a, x) => a + (x.line[4] as number), 0),
          svPct: sa > 0 ? round(sv / sa) : null, toi: last.reduce((a, x) => a + (x.line[5] as number), 0),
          w: last.filter((x) => x.line[6] === 'W').length, l: last.filter((x) => x.line[6] === 'L').length, otl: last.filter((x) => x.line[6] === 'OTL').length,
        };
      }
      if (s) entry.season = s;
      if (apps.length) entry.starts = goalieStartFacts(apps.filter((x) => x.line[1] === 1).map((x) => x.date), teamDates(p.team));
      out.goalies[key] = entry;
      continue;
    }
    const apps = skaterApps.get(id) ?? [];
    const s = season?.skaters[id];
    if (!apps.length && !s) continue;
    const entry: InsightsInputsFile['players'][string] = { team: p.team };
    if (apps.length) {
      entry.last5 = skaterWindow(apps.slice(0, 5), cfg);
      entry.last10 = skaterWindow(apps.slice(0, 10), cfg);
      entry.window = skaterWindow(apps, cfg);
    }
    const group = posGroup(p.positions);
    entry.features = skaterFeatures({
      apps: apps as WindowAppearance[], group, current: cur.get(id), previous: prev.get(id), previous2: prev2.get(id), posAvg: posAvg[group], posMinutes: posMinutes[group === 'F' ? 0 : 1]!, teamDates: teamDates(p.team),
    });
    const part = playerParticipation(sequences.get(id) ?? [], participationModel);
    if (part) entry.features.participation = part;
    if (s) {
      const st = statsById.get(id);
      const evPts = st && st.gamesPlayed === s.gp ? st.points - st.ppPoints - st.shPoints : null;
      const talent: TalentEvidence = {
        g: s.g, a: s.a, a1: s.a1, a2: s.a2, pts: s.pts, evPts, ppp: st && st.gamesPlayed === s.gp ? st.ppPoints : null,
        sog: s.sog, hit: s.hit, blk: s.blk, pim: s.pim, pm: st && st.gamesPlayed === s.gp ? st.plusMinus : null,
        evG: s.evG ?? null, ppG: s.ppG ?? null, shp: st && st.gamesPlayed === s.gp ? st.shPoints : s.shPts ?? null,
      };
      const pg = (v: number | null) => (v === null ? null : round(v / s.gp, 1));
      entry.season = { gp: s.gp, talent, opportunity: { toiPg: pg(s.toi), evToiPg: pg(s.evToi), ppToiPg: pg(s.ppToi), shToiPg: pg(s.shToi), ppSharePg: s.ppSharePg } };
    }
    out.players[key] = entry;
  }
  const abbrevs = new Set([...Object.values(state.meta.teamAbbrevs), ...teamGames.keys()]);
  for (const t of [...abbrevs].sort()) {
    const entry: InsightsInputsFile['teams'][string] = {};
    const teamId = Object.entries(state.meta.teamAbbrevs).find(([, a]) => a === t)?.[0];
    const s = teamId ? season?.teams[teamId] : undefined;
    if (s) entry.season = s;
    const g = (teamGames.get(t) ?? []).slice(0, 10);
    if (g.length && g.every((x) => x.gf !== null && x.sf !== null && x.ppOpp !== null && x.ppGoals !== null && x.ppToi !== null)) {
      const ppOpp = g.reduce((a, x) => a + x.ppOpp!, 0);
      const ppGoals = g.reduce((a, x) => a + x.ppGoals!, 0);
      entry.last10 = { gp: g.length, gf: g.reduce((a, x) => a + x.gf!, 0), sf: g.reduce((a, x) => a + x.sf!, 0), ppOpp, ppGoals, ppToi: g.reduce((a, x) => a + x.ppToi!, 0), ppPct: ppOpp > 0 ? round(ppGoals / ppOpp) : null };
    }
    if (entry.season || entry.last10) out.teams[t] = entry;
  }
  return out;
}

/** Reasons not to replace the previous insights-inputs.json with this build (empty = safe to write). */
export function insightsUpdateProblems(next: InsightsInputsFile, previous: InsightsInputsFile | undefined, players: PlayersFile, skaterStats: SkaterStatsFile | undefined, seasonPresent: boolean): string[] {
  const problems = [...validateInsightsInputs(next, { season: next.season, playerIds: new Set(players.players.map((p) => p.id)) }).errors.slice(0, 5)];
  if (seasonPresent && skaterStats?.season === next.season) {
    const withGames = new Set(skaterStats.skaters.map((s) => s.nhlId));
    const current = players.players.filter((p) => p.nhlId !== undefined && !p.inactive && !p.positions.includes('G') && withGames.has(p.nhlId));
    const covered = current.filter((p) => next.players[`nhl-${p.nhlId}`]?.season).length;
    if (current.length && covered / current.length < 0.9) problems.push(`only ${covered}/${current.length} current roster skaters with games have a season block`);
  }
  if (previous && previous.season === next.season && previous.version === next.version) {
    const before = Object.keys(previous.players).length;
    const now = Object.keys(next.players).length;
    if (now < before * 0.9) problems.push(`players fell from ${before} to ${now}`);
    if (previous.windowNights > 0 && next.windowNights < previous.windowNights * 0.5) problems.push(`window nights fell from ${previous.windowNights} to ${next.windowNights}`);
  }
  return problems;
}
