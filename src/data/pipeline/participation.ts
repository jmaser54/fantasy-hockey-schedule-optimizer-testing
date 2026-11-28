/**
 * Participation: a supporting availability consideration, not a value model (simplified 2026-11-28; §J).
 *
 * Built from the private game window only (appearances against his team's schedule); the cause of an
 * absence (injury, scratch, assignment) is never inferred and no return date is predicted. Per player:
 * - sequence: his team's games from his first appearance in the window (a call-up's earlier team games
 *   don't count against him), using his team on each date (trades);
 * - facts: team games, games played (every missed game counts) and his current run of missed team games;
 * - Next Week share: 1 unless he is CURRENTLY in a prolonged absence (PARTICIPATION.longAbsenceGames or
 *   more missed in a row). Then it is the measured share of their next 4 team games that players in that
 *   state (5–9 or 10+ games missed) actually played. A player who has returned is never discounted for an
 *   earlier absence, and 1–4 missed games never lower value (cards show the fact instead).
 * Playoff value has no participation discount at all: a current absence isn't evidence about February–April.
 * The shares are measured from all skaters' histories on every build and published as aggregates.
 */
import { PARTICIPATION } from '../../domain/insightsSettings.ts';

export const ABSENCE_BUCKETS = ['5-9', '10+'] as const;
export type AbsenceBucket = (typeof ABSENCE_BUCKETS)[number];
/** The prolonged-absence bucket for a missed streak, or undefined below PARTICIPATION.longAbsenceGames. */
export const absenceBucket = (s: number): AbsenceBucket | undefined => (s < PARTICIPATION.longAbsenceGames ? undefined : s <= 9 ? '5-9' : '10+');

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

export interface ParticipationModel {
  longAbsenceGames: number;
  /**
   * Next Week share for a player currently in a prolonged absence: among all (player, team game) states in
   * the window where the player had missed 5–9 / 10+ team games in a row and 4 more team games followed,
   * the mean share of those 4 games he played. A bucket with fewer than PARTICIPATION.minSamples states
   * borrows the 5–9 states; with none at all the share is 0.5 (assumption).
   */
  nextWeekShare: Record<AbsenceBucket, number>;
  samples: { players: number; states: Record<AbsenceBucket, number> };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function fitParticipation(seqs: readonly (readonly boolean[])[]): ParticipationModel {
  const P = PARTICIPATION;
  const sum: Record<AbsenceBucket, number> = { '5-9': 0, '10+': 0 };
  const n: Record<AbsenceBucket, number> = { '5-9': 0, '10+': 0 };
  for (const seq of seqs) {
    for (let t = 0; t + P.nextWeekGames < seq.length; t++) {
      const b = absenceBucket(streakAt(seq, t));
      if (!b) continue;
      sum[b] += seq.slice(t + 1, t + 1 + P.nextWeekGames).filter(Boolean).length / P.nextWeekGames;
      n[b]++;
    }
  }
  const share = (b: AbsenceBucket) => {
    if (n[b] >= P.minSamples || b === '5-9') return n[b] ? r3(sum[b] / n[b]) : 0.5;
    const s = sum['5-9'] + sum[b], c = n['5-9'] + n[b];
    return c ? r3(s / c) : 0.5;
  };
  return { longAbsenceGames: P.longAbsenceGames, nextWeekShare: { '5-9': share('5-9'), '10+': share('10+') }, samples: { players: seqs.length, states: n } };
}

export interface PlayerParticipation {
  /** His team's games since his first appearance in the window, and games played (all misses count). */
  teamGames: number;
  played: number;
  /** His team's games missed in a row up to the latest night (a fact; the cause is unknown). */
  streak: number;
  /** Next Week value multiplier: 1, or the measured share when he is currently in a prolonged absence. */
  nextWeek: number;
}

export function playerParticipation(seq: readonly boolean[], m: ParticipationModel): PlayerParticipation | undefined {
  if (!seq.length) return undefined;
  const s = streakAt(seq, seq.length - 1);
  const b = absenceBucket(s);
  return { teamGames: seq.length, played: seq.filter(Boolean).length, streak: s, nextWeek: b ? m.nextWeekShare[b] : 1 };
}
