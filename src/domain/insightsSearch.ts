/**
 * Add/drop search for Custom Insights (§J).
 *
 * Lineup value over a period: each date, players with a game are offered skater seats in order of
 * value per game (greedy on the transversal matroid, so the lineup has the most filled seats and the
 * highest total value; verified against brute force). The value of a roster is the sum over dates.
 *
 * Search: a candidate X added to the full roster with nobody dropped gains at least as much as any
 * swap involving X (values are non-negative, so adding a player never lowers the total). That gain is
 * an upper limit; candidates are tried in order of it, and the search stops once no remaining limit
 * can beat the results already found. It always finds the true best moves (verified against
 * exhaustive search in insightsSearch.test.ts).
 */
import { maxBipartiteMatching } from './matching.ts';
import type { Seat } from './optimizer.ts';
import { playerGameOn, type ScheduleIndex } from './schedule.ts';
import type { ISODate, Position, TeamStint } from './types.ts';

export interface ValuedPlayer {
  id: string;
  team: string;
  stints?: TeamStint[];
  positions: Position[];
  /** Value per game (≥ 0). */
  value: number;
}

/** Seats a skater can fill (goalie-only seats never take skaters). */
export const skaterSeats = (seats: readonly Seat[]) => seats.filter((s) => s.accepts.some((p) => p !== 'G'));

export interface DayLineup {
  total: number;
  /** Seated player ids. */
  seated: string[];
}

const byValue = (a: ValuedPlayer, b: ValuedPlayer) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Seat indices a player can fill, most specific first. */
function seatsFor(p: ValuedPlayer, seats: readonly Seat[]): number[] {
  const sk = p.positions.filter((x) => x !== 'G');
  const out: number[] = [];
  seats.forEach((s, i) => {
    if (sk.some((x) => s.accepts.includes(x))) out.push(i);
  });
  return out.sort((a, b) => seats[a]!.accepts.length - seats[b]!.accepts.length);
}

/** Lineup for players already sorted by value (greedy order). */
function lineupOf(sorted: readonly ValuedPlayer[], seatCount: number, adj: (p: ValuedPlayer) => number[]): DayLineup {
  const m = maxBipartiteMatching(sorted.length, seatCount, sorted.map(adj));
  const seated: string[] = [];
  let total = 0;
  m.leftToRight.forEach((seat, i) => {
    if (seat >= 0) {
      seated.push(sorted[i]!.id);
      total += sorted[i]!.value;
    }
  });
  return { total, seated };
}

/** One date's best lineup by value. Ties are broken by id so results are deterministic. */
export function dayLineup(players: readonly ValuedPlayer[], seats: readonly Seat[], schedule: ScheduleIndex, date: ISODate): DayLineup {
  const playing = players.filter((p) => playerGameOn(schedule, p, date)).sort(byValue);
  return lineupOf(playing, seats.length, (p) => seatsFor(p, seats));
}

export interface RosterValue {
  total: number;
  byDate: Map<ISODate, DayLineup>;
}

export function rosterValue(players: readonly ValuedPlayer[], seats: readonly Seat[], schedule: ScheduleIndex, dates: readonly ISODate[]): RosterValue {
  const byDate = new Map<ISODate, DayLineup>();
  let total = 0;
  for (const d of dates) {
    const l = dayLineup(players, seats, schedule, d);
    byDate.set(d, l);
    total += l.total;
  }
  return { total, byDate };
}

export interface SwapResult {
  add: string;
  /** Undefined: added to an open roster spot. */
  drop?: string;
  gain: number;
  score: number;
  /** Lineup after the move, by date (only dates where it changed are needed by callers, but all are here). */
  after: Map<ISODate, DayLineup>;
}

export interface SearchInput {
  /** Active (non-IR) skaters on the roster. */
  roster: readonly ValuedPlayer[];
  /** Roster ids that may be dropped (never ★, IR or players without data). */
  droppable: ReadonlySet<string>;
  /** True when the roster has an open spot: a candidate can be added without a drop. */
  openSpot: boolean;
  candidates: readonly ValuedPlayer[];
  seats: readonly Seat[];
  schedule: ScheduleIndex;
  dates: readonly ISODate[];
  /** How many candidates to return (one move per candidate). */
  k: number;
  /**
   * Ranking score for a move; null = the move doesn't qualify. Must never exceed the raw gain (the
   * stopping rule depends on it). Defaults to the gain.
   */
  score?: (add: ValuedPlayer, drop: ValuedPlayer | undefined, gain: number, after: Map<ISODate, DayLineup>, before: RosterValue) => number | null;
}

export interface SearchResult {
  before: RosterValue;
  moves: SwapResult[];
  /** Optimizer evaluations of full moves (for tests and diagnostics). */
  evaluations: number;
}

export function searchMoves(input: SearchInput): SearchResult {
  const { roster, seats, schedule, dates } = input;
  const before = rosterValue(roster, seats, schedule, dates);
  const score = input.score ?? ((_a, _d, gain) => gain);
  // Precomputed: each player's seats and game dates, and the roster's players by date in value order.
  const adjCache = new Map<string, number[]>();
  const adj = (p: ValuedPlayer) => {
    let a = adjCache.get(p.id);
    if (!a) adjCache.set(p.id, (a = seatsFor(p, seats)));
    return a;
  };
  const datesCache = new Map<string, ISODate[]>();
  const playsOn = (p: ValuedPlayer) => {
    let ds = datesCache.get(p.id);
    if (!ds) datesCache.set(p.id, (ds = dates.filter((d) => !!playerGameOn(schedule, p, d))));
    return ds;
  };
  const rosterOn = new Map<ISODate, ValuedPlayer[]>(dates.map((d) => [d, []]));
  for (const p of [...roster].sort(byValue)) for (const d of playsOn(p)) rosterOn.get(d)!.push(p);
  // Only dates where the changed players play can change; others keep the base lineup.
  const evalMove = (add: ValuedPlayer, drop: ValuedPlayer | undefined, full = true) => {
    const addDates = new Set(playsOn(add));
    const touched = new Set([...addDates, ...(drop ? playsOn(drop) : [])]);
    const after = full ? new Map(before.byDate) : undefined;
    let total = before.total;
    for (const d of touched) {
      const list = rosterOn.get(d)!.filter((p) => p.id !== drop?.id);
      if (addDates.has(d)) {
        const at = list.findIndex((p) => byValue(add, p) < 0);
        list.splice(at < 0 ? list.length : at, 0, add);
      }
      const l = lineupOf(list, seats.length, adj);
      total += l.total - before.byDate.get(d)!.total;
      after?.set(d, l);
    }
    return { gain: total - before.total, after };
  };
  const limits = input.candidates
    .map((c) => ({ c, gain: evalMove(c, undefined, false).gain }))
    .sort((a, b) => b.gain - a.gain || (a.c.id < b.c.id ? -1 : 1));
  let evaluations = limits.length;
  const found: SwapResult[] = [];
  const kth = () => (found.length < input.k ? -Infinity : found[input.k - 1]!.score);
  const drops = roster.filter((p) => input.droppable.has(p.id));
  for (const lim of limits) {
    if (lim.gain <= 0 || lim.gain <= kth()) break;
    let best: SwapResult | undefined;
    const consider = (drop: ValuedPlayer | undefined, gain: number, after: Map<ISODate, DayLineup>) => {
      const s = score(lim.c, drop, gain, after, before);
      if (s === null || s <= 0) return;
      if (!best || s > best.score || (s === best.score && (drop?.id ?? '') < (best.drop ?? ''))) best = { add: lim.c.id, drop: drop?.id, gain, score: s, after };
    };
    if (input.openSpot) consider(undefined, lim.gain, evalMove(lim.c, undefined).after!);
    for (const y of drops) {
      const r = evalMove(lim.c, y);
      evaluations++;
      consider(y, r.gain, r.after!);
    }
    if (best) {
      found.push(best);
      found.sort((a, b) => b.score - a.score || (a.add < b.add ? -1 : 1));
      found.length = Math.min(found.length, input.k);
    }
  }
  return { before, moves: found, evaluations };
}
