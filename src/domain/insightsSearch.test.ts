import { describe, expect, it } from 'vitest';
import { eachDate } from './dates.ts';
import { dayLineup, rosterValue, searchMoves, skaterSeats, type ValuedPlayer } from './insightsSearch.ts';
import { expandSeats } from './optimizer.ts';
import { ScheduleIndex } from './schedule.ts';
import type { Game, LineupSlot, Position } from './types.ts';

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
const POS: Position[][] = [['C'], ['LW'], ['RW'], ['D'], ['C', 'LW'], ['LW', 'RW'], ['C', 'RW'], ['D']];
const LAYOUTS: LineupSlot[][] = [
  [{ id: 'C', label: 'C', count: 1, accepts: ['C'] }, { id: 'W', label: 'W', count: 2, accepts: ['LW', 'RW'] }, { id: 'D', label: 'D', count: 2, accepts: ['D'] }, { id: 'U', label: 'UTIL', count: 1, accepts: ['C', 'LW', 'RW', 'D'] }, { id: 'G', label: 'G', count: 1, accepts: ['G'] }],
  [{ id: 'F', label: 'F', count: 3, accepts: ['C', 'LW', 'RW'] }, { id: 'D', label: 'D', count: 2, accepts: ['D'] }],
  [{ id: 'C', label: 'C', count: 2, accepts: ['C'] }, { id: 'LW', label: 'LW', count: 1, accepts: ['LW'] }, { id: 'RW', label: 'RW', count: 1, accepts: ['RW'] }, { id: 'D', label: 'D', count: 1, accepts: ['D'] }],
];
const dates = eachDate('2027-03-01', '2027-03-07');
function schedule(): ScheduleIndex {
  const games: Game[] = [];
  let n = 0;
  for (const d of dates) {
    const t = [...TEAMS].sort(() => rnd() - 0.5);
    const count = Math.floor(rnd() * 5);
    for (let i = 0; i < count; i++) games.push({ id: `g${n++}`, date: d, home: t[2 * i]!, away: t[2 * i + 1]! });
  }
  return new ScheduleIndex(games);
}
const vp = (id: string): ValuedPlayer => ({ id, team: pick(TEAMS), positions: pick(POS), value: Math.round(rnd() * 50) / 10 });

/** Brute force: best total over every way of seating the day's players (tiny fixtures only). */
function bruteDay(players: ValuedPlayer[], slots: LineupSlot[], sched: ScheduleIndex, date: string): number {
  const seats = skaterSeats(expandSeats(slots));
  const playing = players.filter((p) => sched.teamGameOn(p.team, date));
  let best = 0;
  const used = new Array(seats.length).fill(false);
  const go = (i: number, total: number) => {
    if (i === playing.length) return void (best = Math.max(best, total));
    go(i + 1, total); // bench
    seats.forEach((s, k) => {
      if (!used[k] && playing[i]!.positions.some((x) => s.accepts.includes(x))) {
        used[k] = true;
        go(i + 1, total + playing[i]!.value);
        used[k] = false;
      }
    });
  };
  go(0, 0);
  return best;
}

describe('value-ordered daily lineup', () => {
  it('equals brute force on random days', () => {
    for (let trial = 0; trial < 300; trial++) {
      const sched = schedule();
      const slots = pick(LAYOUTS);
      const players = Array.from({ length: 7 }, (_, i) => vp(`p${i}`));
      const d = pick(dates);
      expect(dayLineup(players, skaterSeats(expandSeats(slots)), sched, d).total).toBeCloseTo(bruteDay(players, slots, sched, d), 9);
    }
  });
});

describe('limit-based add/drop search', () => {
  it('finds the same best moves as exhaustive search (positions, empty seats, overlapping schedules)', () => {
    let fullEvaluations = 0;
    let limitEvaluations = 0;
    for (let trial = 0; trial < 200; trial++) {
      const sched = schedule();
      const seats = skaterSeats(expandSeats(pick(LAYOUTS)));
      const roster = Array.from({ length: 4 + Math.floor(rnd() * 5) }, (_, i) => vp(`r${i}`));
      const candidates = Array.from({ length: 12 }, (_, i) => vp(`c${i}`));
      const droppable = new Set(roster.filter(() => rnd() > 0.25).map((p) => p.id)); // some protected (★ / IR)
      const openSpot = rnd() > 0.7;
      const k = 1 + Math.floor(rnd() * 3);
      const res = searchMoves({ roster, droppable, openSpot, candidates, seats, schedule: sched, dates, k });
      // Exhaustive: every candidate × every allowed drop (and the open spot).
      const base = rosterValue(roster, seats, sched, dates).total;
      const best = candidates
        .map((c) => {
          const opts = [...(openSpot ? [undefined] : []), ...roster.filter((p) => droppable.has(p.id))].map((y) => {
            fullEvaluations++;
            return rosterValue([...roster.filter((p) => p.id !== y?.id), c], seats, sched, dates).total - base;
          });
          return { id: c.id, gain: Math.max(-Infinity, ...opts) };
        })
        .filter((x) => x.gain > 0)
        .sort((a, b) => b.gain - a.gain || (a.id < b.id ? -1 : 1))
        .slice(0, k);
      limitEvaluations += res.evaluations;
      expect(res.moves.map((m) => Math.round(m.gain * 1e6))).toEqual(best.map((b) => Math.round(b.gain * 1e6)));
      for (const m of res.moves) if (m.drop) expect(droppable.has(m.drop)).toBe(true);
    }
    expect(limitEvaluations).toBeLessThan(fullEvaluations);
  });

  it('never drops a protected player and is deterministic', () => {
    const sched = new ScheduleIndex(dates.map((d, i) => ({ id: `g${i}`, date: d, home: 'AAA', away: 'BBB' })));
    const seats = skaterSeats(expandSeats(LAYOUTS[1]!));
    const roster: ValuedPlayer[] = [
      { id: 'star', team: 'AAA', positions: ['C'], value: 0.1 },
      { id: 'ir', team: 'AAA', positions: ['C'], value: 0.2 },
      { id: 'ok', team: 'BBB', positions: ['C'], value: 1 },
      { id: 'd1', team: 'AAA', positions: ['D'], value: 2 },
      { id: 'd2', team: 'BBB', positions: ['D'], value: 2 },
    ];
    const candidates: ValuedPlayer[] = [{ id: 'x', team: 'AAA', positions: ['C'], value: 3 }];
    const run = () => searchMoves({ roster, droppable: new Set(['ok']), openSpot: false, candidates, seats, schedule: sched, dates, k: 3 });
    const a = run();
    expect(a.moves.map((m) => m.drop)).toEqual(['ok']);
    expect(JSON.stringify(run().moves.map(({ after: _a, ...m }) => m))).toBe(JSON.stringify(a.moves.map(({ after: _a, ...m }) => m)));
  });
});
