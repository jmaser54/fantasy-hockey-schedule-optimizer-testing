/**
 * Derived Insights features computed from the private game window (never published as game lines):
 * blended Talent rates, expected minutes for Next Week and the playoffs, the three-state power-play
 * status, appearance facts and goalie start facts. Settings: src/domain/insightsSettings.ts.
 */
import type { PosGroup } from '../../domain/insightsSettings.ts';
import { MIN_MINUTES_SHARE, MINUTES_HALF_TRUST, PP_PERSISTENCE, PP_RULE, PRIOR_MIN_GAMES, PRIOR_SEASON_MINUTES_GAMES, RECENT_MINUTES_GAMES, SEASON_RELIABILITY_GAMES, SITUATION_MINUTES_PER_GAME, TALENT_HALF_TRUST } from '../../domain/insightsSettings.ts';
import { ppStatus, type PpGame } from '../../domain/ppStatus.ts';
import type { ExpectedMinutes, SkaterFeatures, TalentRates } from '../format.ts';
import type { SkaterLine } from './gamelog.ts';

/** Season totals the rates are built from (seconds for ice time). */
export interface SeasonTotals {
  gp: number;
  /** All points (verified scoring report); situational splits below come from the summary report. */
  pts?: number | null;
  g: number | null;
  evG: number | null;
  ppG: number | null;
  shG: number | null;
  evPts: number | null;
  ppPts: number | null;
  shPts: number | null;
  sog: number | null;
  hit: number | null;
  blk: number | null;
  pim: number | null;
  pm: number | null;
  fow: number | null;
  toi: number | null;
  evToi: number | null;
  ppToi: number | null;
  shToi: number | null;
  ppSharePg: number | null;
}

export const RATE_KEYS = ['evPts', 'ppPts', 'shPts', 'evG', 'ppG', 'shG', 'sog', 'hit', 'blk', 'pim', 'pm', 'fow'] as const;
type RateKey = (typeof RATE_KEYS)[number];
/** Which minutes each rate is measured against (each situation only against its own minutes). */
const RATE_MINUTES: Record<RateKey, 'evToi' | 'ppToi' | 'shToi' | 'toi'> = {
  evPts: 'evToi', ppPts: 'ppToi', shPts: 'shToi', evG: 'evToi', ppG: 'ppToi', shG: 'shToi',
  sog: 'toi', hit: 'toi', blk: 'toi', pim: 'toi', pm: 'toi', fow: 'toi',
};
const HALF_TRUST_KEY: Record<RateKey, keyof typeof TALENT_HALF_TRUST> = {
  evPts: 'evPts', ppPts: 'ppPts', shPts: 'shPts', evG: 'goals', ppG: 'goals', shG: 'goals',
  sog: 'sog', hit: 'hit', blk: 'blk', pim: 'pim', pm: 'pm', fow: 'fow',
};

export const posGroup = (positions: readonly string[]): PosGroup => (positions.includes('D') && !positions.some((p) => p === 'C' || p === 'LW' || p === 'RW') ? 'D' : 'F');

const per60 = (count: number | null, secs: number | null): number | null => (typeof count !== 'number' || typeof secs !== 'number' || secs <= 0 ? null : (count * 3600) / secs);
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Position averages (Σ counts ÷ Σ minutes) over players with at least `minGp` games. */
export function positionRates(totals: Iterable<[SeasonTotals, PosGroup]>, minGp: number): Record<PosGroup, Partial<Record<RateKey, number>>> {
  const acc: Record<PosGroup, Record<string, [number, number]>> = { F: {}, D: {} };
  for (const [t, grp] of totals) {
    if (t.gp < minGp) continue;
    for (const k of RATE_KEYS) {
      const c = t[k];
      const m = t[RATE_MINUTES[k]];
      if (typeof c !== 'number' || typeof m !== 'number' || m <= 0) continue;
      const a = (acc[grp][k] ??= [0, 0]);
      a[0] += c;
      a[1] += m;
    }
  }
  const out: Record<PosGroup, Partial<Record<RateKey, number>>> = { F: {}, D: {} };
  for (const g of ['F', 'D'] as const) for (const [k, [c, m]] of Object.entries(acc[g])) if (m > 0) out[g][k as RateKey] = (c * 3600) / m;
  return out;
}

export type PriorSource = 'player' | 'player2' | 'partial' | 'position';

const SITUATION_OF: Partial<Record<RateKey, 'ev' | 'pp' | 'sh'>> = { evPts: 'ev', evG: 'ev', ppPts: 'pp', ppG: 'pp', shPts: 'sh', shG: 'sh' };

/** Half-trust in minutes for a situational rate (measured half-trust games × typical minutes per game). */
export function halfTrustMinutes(k: RateKey, group: PosGroup): number | null {
  const sit = SITUATION_OF[k];
  return sit ? TALENT_HALF_TRUST[HALF_TRUST_KEY[k]][group] * SITUATION_MINUTES_PER_GAME[sit][group] : null;
}

/**
 * A season's own situational rate shrunk toward `base` by its minutes: (count + M × base) ÷ (minutes + M),
 * per 60. Below MIN_MINUTES_SHARE × M minutes the season isn't used and `base` stands.
 */
export function shrinkByMinutes(count: number | null, secs: number | null, M: number, base: number | null): number | null {
  if (typeof count !== 'number' || typeof secs !== 'number') return base;
  const mins = secs / 60;
  if (mins < MIN_MINUTES_SHARE * M) return base;
  if (base === null) return (count * 60) / mins;
  return ((count + (M * base) / 60) / (mins + M)) * 60;
}

/** Which earlier season is his baseline (see PRIOR_MIN_GAMES). */
export function choosePrior(previous: SeasonTotals | undefined, previous2: SeasonTotals | undefined): { season: SeasonTotals | undefined; source: PriorSource } {
  if (previous && previous.gp >= PRIOR_MIN_GAMES) return { season: previous, source: 'player' };
  if (previous2 && previous2.gp >= PRIOR_MIN_GAMES) return { season: previous2, source: 'player2' };
  const best = [previous, previous2].filter((s): s is SeasonTotals => !!s && s.gp > 0).sort((a, b) => b.gp - a.gp)[0];
  return best ? { season: best, source: 'partial' } : { season: undefined, source: 'position' };
}

/**
 * Talent rates.
 * - Situational points and goals (even strength, PP, short-handed), by minutes: the baseline season's
 *   rate shrunk toward players at his position, then the current season's rate shrunk toward that,
 *   each weighted by its own minutes in that situation (shrinkByMinutes).
 * - Shots, hits, blocks, PIM, plus/minus, faceoff wins (per 60 of all ice time), by games as measured:
 *   current weight = gp ÷ (gp + half-trust games). The baseline season (any source) is first shrunk toward
 *   the position by its own games (SEASON_RELIABILITY_GAMES), so a short season counts as partial
 *   evidence while a full season keeps most of its player-specific rate.
 */
export function talentRates(
  current: SeasonTotals | undefined,
  previous: SeasonTotals | undefined,
  posAvg: Partial<Record<RateKey, number>>,
  group: PosGroup,
  previous2?: SeasonTotals,
): { rates: TalentRates; gp: number; prior: PriorSource } {
  const gp = current?.gp ?? 0;
  const { season: base, source } = choosePrior(previous, previous2);
  const rates = {} as TalentRates;
  for (const k of RATE_KEYS) {
    const r0 = posAvg[k] ?? null;
    const M = halfTrustMinutes(k, group);
    let v: number | null;
    if (M !== null) {
      const prior = base ? shrinkByMinutes(base[k], base[RATE_MINUTES[k]], M, r0) : r0;
      v = current ? shrinkByMinutes(current[k], current[RATE_MINUTES[k]], M, prior) : prior;
    } else {
      const K = TALENT_HALF_TRUST[HALF_TRUST_KEY[k]][group];
      const own = base ? per60(base[k], base[RATE_MINUTES[k]]) : null;
      const G = SEASON_RELIABILITY_GAMES[k as keyof typeof SEASON_RELIABILITY_GAMES];
      const rp = own === null ? r0 : r0 === null ? own : (base!.gp * own + G * r0) / (base!.gp + G);
      const rc = current ? per60(current[k], current[RATE_MINUTES[k]]) : null;
      v = rc === null ? rp : rp === null ? rc : (gp * rc + K * rp) / (gp + K);
    }
    rates[k] = v === null ? null : r4(v);
  }
  return { rates, gp, prior: source };
}

/** One appearance in the window (newest first in the caller's arrays). */
export interface WindowAppearance {
  date: string;
  line: SkaterLine;
  teamPpToi: number | null;
}

const meanOf = (a: readonly number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const blend = (sample: number | null, n: number, prior: number | null, H: number): number | null =>
  sample === null ? prior : prior === null ? sample : (n * sample + H * prior) / (n + H);

/**
 * Expected minutes. Next Week leans on the latest RECENT_MINUTES_GAMES games; the playoffs use the whole
 * window (a brief change counts only in proportion to its share of the window). PP share: a confirmed
 * forward promotion uses baseline + retained share × rise (10-game figure for Next Week, 30-game figure
 * for the playoffs); an observed (unconfirmed) rise counts at his baseline for the playoffs.
 * Total, even-strength and short-handed minutes in both contexts are then anchored to his previous season's
 * per-game minutes (`previous`, a season with PRIOR_MIN_GAMES games, chosen by the caller) as if it were
 * PRIOR_SEASON_MINUTES_GAMES extra games, so the anchor fades as this season's games accumulate. PP share is
 * not anchored.
 */
export function expectedMinutes(apps: readonly WindowAppearance[], season: SeasonTotals | undefined, posMinutes: { toi: number; evToi: number; shToi: number; ppShare: number }, pp: ReturnType<typeof ppStatus>, previous?: SeasonTotals): { nextWeek: ExpectedMinutes; playoffs: ExpectedMinutes } {
  const priorPg = (secs: number | null | undefined, fallback: number) => (season && season.gp > 0 && secs !== null && secs !== undefined ? secs / season.gp / 60 : fallback);
  const prior = { toi: priorPg(season?.toi, posMinutes.toi), evToi: priorPg(season?.evToi, posMinutes.evToi), shToi: priorPg(season?.shToi, posMinutes.shToi) };
  const recent = apps.slice(0, RECENT_MINUTES_GAMES);
  const mins = (list: readonly WindowAppearance[], i: number) => meanOf(list.map((a) => a.line[i]).filter((v): v is number => typeof v === 'number').map((v) => v / 60));
  const share = (list: readonly WindowAppearance[]) => {
    const u = list.filter((a) => typeof a.line[15] === 'number' && a.teamPpToi !== null && a.teamPpToi >= PP_RULE.minTeamPpSeconds);
    const team = u.reduce((s, a) => s + a.teamPpToi!, 0);
    return { v: team > 0 ? Math.min(1, u.reduce((s, a) => s + (a.line[15] as number), 0) / team) : null, n: u.length };
  };
  const seasonShare = season?.ppSharePg ?? posMinutes.ppShare;
  // Prior-season anchor: (n × current + W × previous) ÷ (n + W), n = games played this season.
  const n = season ? season.gp : apps.length;
  const prevPg = (secs: number | null | undefined) => (previous && previous.gp >= PRIOR_MIN_GAMES && secs !== null && secs !== undefined ? secs / previous.gp / 60 : null);
  const anchor = { toi: prevPg(previous?.toi), evToi: prevPg(previous?.evToi), shToi: prevPg(previous?.shToi) };
  const W = PRIOR_SEASON_MINUTES_GAMES;
  const anchored = (v: number, a: number | null) => (a === null ? v : (n * v + W * a) / (n + W));
  const ctx = (list: readonly WindowAppearance[], ppShareOverride: number | null): ExpectedMinutes => {
    const s = share(list);
    const v = (i: number, H: number, p: number, a: number | null) => r1(anchored(blend(mins(list, i), list.length, p, H) ?? p, a));
    return {
      toi: v(13, MINUTES_HALF_TRUST.toi, prior.toi, anchor.toi),
      evToi: v(14, MINUTES_HALF_TRUST.evToi, prior.evToi, anchor.evToi),
      shToi: v(16, MINUTES_HALF_TRUST.shToi, prior.shToi, anchor.shToi),
      ppShare: r4(ppShareOverride ?? blend(s.v, s.n, seasonShare, MINUTES_HALF_TRUST.ppShare) ?? seasonShare),
    };
  };
  const confirmed = pp.state === 'confirmed' && pp.baseline !== null && pp.rise !== null;
  const nextShare = confirmed ? Math.min(1, pp.baseline! + PP_PERSISTENCE.retainedNext10 * pp.rise!) : null;
  const playoffShare = confirmed ? Math.min(1, pp.baseline! + PP_PERSISTENCE.retainedNext30 * pp.rise!) : pp.state === 'observed' ? pp.baseline : null;
  return { nextWeek: ctx(recent, nextShare), playoffs: ctx(apps, playoffShare) };
}

const ptsPg = (t: SeasonTotals | undefined) => {
  if (!t || t.gp < 1) return null;
  const pts = typeof t.pts === 'number' ? t.pts : t.evPts !== null && t.ppPts !== null && t.shPts !== null ? t.evPts + t.ppPts + t.shPts : null;
  return pts === null ? null : Math.round((pts / t.gp) * 1000) / 1000;
};

/** Everything published for one skater, from his window appearances (newest first). */
export function skaterFeatures(input: {
  apps: readonly WindowAppearance[];
  group: PosGroup;
  current: SeasonTotals | undefined;
  previous: SeasonTotals | undefined;
  /** The season before the previous one (baseline when the previous season is too short). */
  previous2?: SeasonTotals;
  posAvg: Partial<Record<RateKey, number>>;
  posMinutes: { toi: number; evToi: number; shToi: number; ppShare: number };
  /** His current team's game dates in the window, newest first. */
  teamDates: readonly string[];
}): SkaterFeatures {
  const { apps, group } = input;
  const ppGames: PpGame[] = [...apps]
    .reverse()
    .filter((a) => typeof a.line[15] === 'number' && a.teamPpToi !== null)
    .map((a) => ({ ppToi: a.line[15] as number, teamPpToi: a.teamPpToi! }));
  const pp = ppStatus(ppGames, group);
  const t = talentRates(input.current, input.previous, input.posAvg, group, input.previous2);
  const ev = (list: readonly WindowAppearance[]) => {
    const v = list.map((a) => a.line[14]).filter((x): x is number => typeof x === 'number');
    return v.length ? r1(v.reduce((s, x) => s + x, 0) / v.length / 60) : null;
  };
  const last = apps[0]?.date ?? null;
  // Minutes anchor: only a previous season with PRIOR_MIN_GAMES games (or the one before), never partial.
  const chosen = choosePrior(input.previous, input.previous2);
  const minutesPrior = chosen.source === 'player' || chosen.source === 'player2' ? chosen.season : undefined;
  return {
    group,
    rates: t.rates,
    rateGames: t.gp,
    prior: t.prior,
    minutes: expectedMinutes(apps, input.current, input.posMinutes, pp, minutesPrior),
    pp,
    evMinutes: { last5: ev(apps.slice(0, 5)), window: ev(apps), windowGames: apps.length },
    lastGame: last,
    teamGamesSinceLast: last === null ? null : input.teamDates.filter((d) => d > last).length,
    production: {
      gp: input.current?.gp ?? 0,
      ptsPg: ptsPg(input.current),
      prevGp: input.previous?.gp ?? 0,
      prevPtsPg: ptsPg(input.previous),
    },
  };
}

/** Verified goalie start facts from gamesStarted (never inferred from appearances). */
export function goalieStartFacts(starts: readonly string[], teamDates: readonly string[]): { teamGames: number; starts: number; last10TeamGames: number; startsLast10: number; consecutiveStarts: number } {
  const set = new Set(starts);
  const last10 = teamDates.slice(0, 10);
  let streak = 0;
  for (const d of teamDates) {
    if (!set.has(d)) break;
    streak++;
  }
  return { teamGames: teamDates.length, starts: teamDates.filter((d) => set.has(d)).length, last10TeamGames: last10.length, startsLast10: last10.filter((d) => set.has(d)).length, consecutiveStarts: streak };
}
