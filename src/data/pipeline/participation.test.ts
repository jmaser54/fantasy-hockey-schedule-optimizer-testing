import { describe, expect, it } from 'vitest';
import { PARTICIPATION } from '../../domain/insightsSettings.ts';
import { absenceBucket, buildSequence, fitParticipation, playerParticipation, streakAt, type ParticipationModel } from './participation.ts';

const seq = (s: string) => [...s].map((c) => c === 'x'); // x = played, . = missed (oldest first)
/** A fixed model for per-player checks (the real one is measured on every build). */
const model: ParticipationModel = { longAbsenceGames: 5, nextWeekShare: { '5-9': 0.25, '10+': 0.15 }, samples: { players: 0, states: { '5-9': 0, '10+': 0 } } };

describe('participation sequences', () => {
  it('starts at his first appearance (call-ups) and follows his team on each date (trades)', () => {
    const teamDates = ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09'];
    expect(buildSequence(teamDates, new Set(['2026-10-05', '2026-10-09']))).toEqual([true, false, true]);
    // A played date outside the given team dates (trade day) is still counted.
    expect(buildSequence(teamDates, new Set(['2026-10-06']))).toEqual([true, false, false]);
    expect(buildSequence(teamDates, new Set())).toEqual([]);
  });

  it('only a current run of 5+ missed games is a prolonged absence', () => {
    expect(PARTICIPATION.longAbsenceGames).toBe(5);
    expect(streakAt(seq('xxx..'), 4)).toBe(2);
    expect([0, 1, 4, 5, 9, 10, 25].map(absenceBucket)).toEqual([undefined, undefined, undefined, '5-9', '5-9', '10+', '10+']);
  });
});

describe('per-player participation', () => {
  it('Marino case: 9 games then 17 missed — discounted for Next Week by the measured share', () => {
    expect(playerParticipation(seq('x'.repeat(9) + '.'.repeat(17)), model)).toEqual({ teamGames: 26, played: 9, streak: 17, nextWeek: 0.15 });
    expect(playerParticipation(seq('x'.repeat(20) + '.'.repeat(6)), model)!.nextWeek).toBe(0.25);
  });

  it('MacKinnon case: 1–4 missed games never lower value', () => {
    for (const k of [1, 2, 3, 4]) expect(playerParticipation(seq('x'.repeat(22) + '.'.repeat(k)), model)).toMatchObject({ streak: k, nextWeek: 1 });
  });

  it('a player back from a long absence is not penalised for it; the facts count every missed game', () => {
    expect(playerParticipation(seq('xx' + '.'.repeat(20) + 'xxx'), model)).toEqual({ teamGames: 25, played: 5, streak: 0, nextWeek: 1 });
  });

  it('a frequently scratched player is not discounted (his dressing record is a fact only)', () => {
    expect(playerParticipation(seq('x.x.x..x.xx.x.x..x.x'), model)).toEqual({ teamGames: 20, played: 10, streak: 0, nextWeek: 1 });
  });
});

describe('measuring the prolonged-absence shares', () => {
  // Players with long absences who come back after a while, and some who don't.
  const pop: boolean[][] = [];
  for (let i = 0; i < 60; i++) pop.push(seq('x'.repeat(26)));
  for (let i = 0; i < 20; i++) pop.push(seq('x.xx.xx.x.xxx.x.xx.x.x.xx'));
  for (let i = 0; i < 15; i++) pop.push(seq('xxxxxx' + '.'.repeat(8) + 'xxxxxxxxxxxx'));
  for (let i = 0; i < 10; i++) pop.push(seq('xxxxx' + '.'.repeat(21)));
  const m = fitParticipation(pop);

  it('measures the share of the next 4 team games played from each state', () => {
    expect(m.samples.players).toBe(105);
    // 5–9 states: the 15 returners are at streaks 5–8 at t = 10..13 (next 4 played: 0, 1/4, 2/4, 3/4 … ),
    // and the 10 non-returners at streaks 5–9 never play again.
    expect(m.samples.states['5-9']).toBeGreaterThan(0);
    expect(m.nextWeekShare['5-9']).toBeGreaterThan(0);
    expect(m.nextWeekShare['5-9']).toBeLessThan(1);
    expect(m.nextWeekShare['10+']).toBe(0); // only non-returners reach 10+, and they never play again
    expect(fitParticipation(pop)).toEqual(m); // deterministic
  });

  it('a sparse 10+ bucket borrows the 5–9 states', () => {
    const few = fitParticipation([...Array(3)].map(() => seq('xxxxx' + '.'.repeat(15))));
    expect(few.samples.states['10+']).toBeLessThan(PARTICIPATION.minSamples);
    expect(few.nextWeekShare['10+']).toBe(0);
    expect(fitParticipation([]).nextWeekShare).toEqual({ '5-9': 0.5, '10+': 0.5 });
  });
});
