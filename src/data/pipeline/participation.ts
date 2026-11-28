/**
 * Participation: how likely a skater is to dress for his team's games (2026-11-28; §J).
 *
 * Built from the private game window only (appearances against his team's schedule); the cause of an
 * absence (injury, scratch, assignment) is never inferred. Per player:
 * - sequence: his team's games from his first appearance in the window (a call-up's earlier team games
 *   don't count against him), using his team on each date (trades);
 * - role rate: games played ÷ team games, leaving out long absence spells (LONG_ABSENCE_GAMES or more
 *   missed in a row, including one still going on), shrunk toward the population rate. It describes how
 *   often he dresses while available (regular vs part-time), so a finished long absence doesn't count
 *   against him;
 * - Next Week = role rate × the measured factor for his current absence streak (how much of their next
 *   4 team games players in that state actually played, relative to their role rate);
 * - Playoffs = role rate × league-wide availability (share of team games not lost to long absence spells)
 *   × for a player in a long absence now, the measured share of players in that state who played again
 *   within the next 10 team games (the longest horizon the window can measure).
 * The factors are measured from all skaters' histories on every build and published as aggregates.
 */
import { PARTICIPATION } from '../../domain/insightsSettings.ts';

export const STREAK_BUCKETS = ['0', '1', '2', '3-4', '5-9', '10+'] as const;
export type StreakBucket = (typeof STREAK_BUCKETS)[number];
export const bucketOf = (s: number): StreakBucket => (s === 0 ? '0' : s === 1 ? '1' : s === 2 ? '2' : s <= 4 ? '3-4' : s <= 9 ? '5-9' : '10+');

/** His team's games (ascending dates) from his first appearance; true = he played. */
export function buildSequence(teamDatesAsc: readonly string[], playedDates: ReadonlySet<string>): boolean[] {
  const first = [...playedDates].sort()[0];
  if (!first) return [];
  const dates = [...new Set([...teamDatesAsc.filter((d) => d >= first), ...playedDates])].sort();
  return dates.map((d) => playedDates.has(d));
}

/** Consecutive missed games ending at index t (0 when he played game t). */
export function streakAt(seq: readonly boolean[], t: number): number {
  let s = 0;
  for (let i = t; i >= 0 && !seq[i]; i--) s++;
  return s;
}

/** Played and counted games over seq[0..end), leaving out missed runs of LONG_ABSENCE_GAMES or more. */
export function roleCounts(seq: readonly boolean[], end = seq.length): { played: number; counted: number; lost: number } {
  let played = 0, counted = 0, lost = 0, run = 0;
  const L = PARTICIPATION.longAbsenceGames;
  for (let i = 0; i < end; i++) {
    if (seq[i]) {
      if (run >= L) lost += run;
      else counted += run;
      run = 0;
      played++;
      counted++;
    } else run++;
  }
  if (run >= L) lost += run;
  else counted += run;
  return { played, counted, lost };
}

export const shrinkRate = (played: number, counted: number, prior: number) => (played + PARTICIPATION.priorGames * prior) / (counted + PARTICIPATION.priorGames);

export interface ParticipationModel {
  longAbsenceGames: number;
  priorGames: number;
  /** Population role rate (players with 10+ counted games). */
  priorRate: number;
  /** League-wide share of team games not lost to long absence spells. */
  availability: number;
  /** Next Week factor by current streak: Σ share of next 4 games played ÷ Σ role rate at the time. */
  nextWeekFactor: Record<StreakBucket, number>;
  /** Share who played again within the next 10 team games, by current streak (long absences only; 1 otherwise). */
  returnWithin10: Record<StreakBucket, number>;
  samples: { players: number; states: Record<StreakBucket, number>; returnStates: Record<StreakBucket, number> };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function fitParticipation(seqs: readonly (readonly boolean[])[]): ParticipationModel {
  const P = PARTICIPATION;
  const regular = seqs.map((s) => roleCounts(s)).filter((c) => c.counted >= 10);
  const priorRate = regular.length ? regular.reduce((a, c) => a + c.played / c.counted, 0) / regular.length : 0.9;
  const long = seqs.filter((s) => s.length >= 10).map((s) => roleCounts(s));
  const total = long.reduce((a, c) => a + c.counted + c.lost, 0);
  const availability = total ? 1 - long.reduce((a, c) => a + c.lost, 0) / total : 1;
  const z = () => Object.fromEntries(STREAK_BUCKETS.map((b) => [b, 0])) as Record<StreakBucket, number>;
  const next = z(), rho = z(), n = z(), back = z(), backN = z();
  for (const seq of seqs) {
    for (let t = P.minHistory - 1; t < seq.length; t++) {
      const b = bucketOf(streakAt(seq, t));
      if (t + P.nextWeekGames < seq.length) {
        const c = roleCounts(seq, t + 1);
        next[b] += seq.slice(t + 1, t + 1 + P.nextWeekGames).filter(Boolean).length / P.nextWeekGames;
        rho[b] += shrinkRate(c.played, c.counted, priorRate);
        n[b]++;
      }
      if (streakAt(seq, t) >= P.longAbsenceGames && t + P.returnHorizon < seq.length) {
        back[b] += seq.slice(t + 1, t + 1 + P.returnHorizon).some(Boolean) ? 1 : 0;
        backN[b]++;
      }
    }
  }
  // Sparse buckets borrow from the neighbouring shorter streak bucket(s) until there are enough samples.
  const pooled = (num: Record<StreakBucket, number>, den: Record<StreakBucket, number>, cnt: Record<StreakBucket, number>, b: StreakBucket, floor: number) => {
    let i = STREAK_BUCKETS.indexOf(b), sn = 0, sd = 0, sc = 0;
    while (i >= floor && sc < P.minSamples) {
      const k = STREAK_BUCKETS[i]!;
      sn += num[k]; sd += den[k]; sc += cnt[k];
      i--;
    }
    return sd > 0 ? sn / sd : null;
  };
  const nextWeekFactor = z(), returnWithin10 = z();
  const longFrom = STREAK_BUCKETS.indexOf(bucketOf(P.longAbsenceGames));
  for (const b of STREAK_BUCKETS) {
    nextWeekFactor[b] = r3(Math.min(1.2, pooled(next, rho, n, b, 0) ?? 1));
    returnWithin10[b] = STREAK_BUCKETS.indexOf(b) < longFrom ? 1 : r3(pooled(back, backN, backN, b, longFrom) ?? 0.5);
  }
  return { longAbsenceGames: P.longAbsenceGames, priorGames: P.priorGames, priorRate: r3(priorRate), availability: r3(availability), nextWeekFactor, returnWithin10, samples: { players: seqs.length, states: n, returnStates: backN } };
}

export interface PlayerParticipation {
  /** His team's games since his first appearance in the window, and games played. */
  teamGames: number;
  played: number;
  /** His team's games missed in a row up to the latest night (a fact; the cause is unknown). */
  streak: number;
  /** How often he dresses while available (long absences left out), shrunk toward the population. */
  roleRate: number;
  /** Expected share of games he dresses for: Next Week, and the playoffs. */
  nextWeek: number;
  playoffs: number;
}

export function playerParticipation(seq: readonly boolean[], m: ParticipationModel): PlayerParticipation | undefined {
  if (!seq.length) return undefined;
  const c = roleCounts(seq);
  const role = shrinkRate(c.played, c.counted, m.priorRate);
  const s = streakAt(seq, seq.length - 1);
  const b = bucketOf(s);
  return {
    teamGames: seq.length,
    played: c.played,
    streak: s,
    roleRate: r3(role),
    nextWeek: r3(Math.min(1, role * m.nextWeekFactor[b])),
    playoffs: r3(Math.min(1, role * m.availability * m.returnWithin10[b])),
  };
}
