/**
 * Three-state power-play status for one skater (owner decisions 2026-11-27/28; §J):
 * - insufficient: fewer than PP_RULE.minUsableGames usable games. No status of any kind is claimed,
 *   and the rule is never run on a shorter baseline.
 * - none: no recent rise.
 * - observed: recent games above his baseline, but the confirmation rule isn't met (or he is a
 *   defenceman, who can never be confirmed). Never called a promotion.
 * - confirmed: forwards only, the exact adopted rule.
 */
import { PP_RULE, type PosGroup } from './insightsSettings.ts';

export interface PpGame {
  /** Player PP seconds. */
  ppToi: number;
  /** His team's PP seconds in that game. */
  teamPpToi: number;
}

export type PpState = 'insufficient' | 'none' | 'observed' | 'confirmed';

export interface PpStatus {
  state: PpState;
  usableGames: number;
  /** Mean share over the 20 baseline games (null when insufficient). */
  baseline: number | null;
  /** Mean share over the latest 8 usable games. */
  recent: number | null;
  /** recent − baseline. */
  rise: number | null;
  /** Elevated games among the latest 8. */
  elevated: number | null;
  latestElevated: boolean | null;
}

/** Games where his team had enough PP time to say anything about his role, oldest first, share capped at 1. */
export function usableShares(games: readonly PpGame[]): number[] {
  return games.filter((g) => g.teamPpToi >= PP_RULE.minTeamPpSeconds).map((g) => Math.min(1, g.ppToi / g.teamPpToi));
}

const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;

/** `games` oldest first (all of his appearances; unusable games are dropped here). */
export function ppStatus(games: readonly PpGame[], group: PosGroup): PpStatus {
  const x = usableShares(games);
  const R = PP_RULE;
  if (x.length < R.minUsableGames) return { state: 'insufficient', usableGames: x.length, baseline: null, recent: null, rise: null, elevated: null, latestElevated: null };
  const run = x.slice(-R.recentGames);
  const base = x.slice(-R.recentGames - R.baselineGames, -R.recentGames);
  const B = mean(base);
  const thr = B + R.elevation;
  const elevated = run.filter((v) => v >= thr - 1e-12).length;
  const latest = run[run.length - 1]! >= thr - 1e-12;
  const runMean = mean(run);
  const rise = runMean - B;
  const withoutBiggest = (runMean * run.length - Math.max(...run)) / (run.length - 1);
  const confirmedRule =
    B <= R.maxBaseline &&
    elevated >= R.minElevated &&
    (!R.latestElevated || latest) &&
    rise >= R.minAverageRise - 1e-12 &&
    (!R.singleGameCheck || withoutBiggest >= thr - 1e-12);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const out = { usableGames: x.length, baseline: r4(B), recent: r4(runMean), rise: r4(rise), elevated, latestElevated: latest };
  if (confirmedRule && R.confirmableGroups.includes(group)) return { state: 'confirmed', ...out };
  // Observed: the latest game and at least one other recent game are elevated, with a positive average rise.
  if (latest && elevated >= 2 && rise > 0) return { state: 'observed', ...out };
  return { state: 'none', ...out };
}
