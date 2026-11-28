import { describe, expect, it } from 'vitest';
import { PARTICIPATION } from '../../domain/insightsSettings.ts';
import { buildSequence, bucketOf, fitParticipation, playerParticipation, roleCounts, streakAt, type ParticipationModel } from './participation.ts';

const seq = (s: string) => [...s].map((c) => c === 'x'); // x = played, . = missed (oldest first)
/** A fixed model for per-player checks (the real one is measured on every build). */
const model: ParticipationModel = {
  longAbsenceGames: 5, priorGames: 10, priorRate: 0.9, availability: 0.9,
  nextWeekFactor: { '0': 1.02, '1': 0.9, '2': 0.8, '3-4': 0.6, '5-9': 0.35, '10+': 0.12 },
  returnWithin10: { '0': 1, '1': 1, '2': 1, '3-4': 1, '5-9': 0.6, '10+': 0.35 },
  samples: { players: 0, states: { '0': 0, '1': 0, '2': 0, '3-4': 0, '5-9': 0, '10+': 0 }, returnStates: { '0': 0, '1': 0, '2': 0, '3-4': 0, '5-9': 0, '10+': 0 } },
};

describe('participation sequences', () => {
  it('starts at his first appearance (call-ups) and follows his team on each date (trades)', () => {
    const teamDates = ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09'];
    expect(buildSequence(teamDates, new Set(['2026-10-05', '2026-10-09']))).toEqual([true, false, true]);
    // A played date outside the given team dates (trade day) is still counted.
    expect(buildSequence(teamDates, new Set(['2026-10-06']))).toEqual([true, false, false]);
    expect(buildSequence(teamDates, new Set())).toEqual([]);
  });

  it('separates long absence spells from short misses', () => {
    expect(PARTICIPATION.longAbsenceGames).toBe(5);
    expect(roleCounts(seq('xx.xx..xx'))).toEqual({ played: 6, counted: 9, lost: 0 }); // short misses count against his role
    expect(roleCounts(seq('xxx.....xxx'))).toEqual({ played: 6, counted: 6, lost: 5 }); // a 5-game spell doesn't
    expect(roleCounts(seq('xxxxx......'))).toEqual({ played: 5, counted: 5, lost: 6 }); // nor one still going on
    expect(streakAt(seq('xxx..'), 4)).toBe(2);
    expect([0, 1, 2, 3, 4, 5, 9, 10, 25].map(bucketOf)).toEqual(['0', '1', '2', '3-4', '3-4', '5-9', '5-9', '10+', '10+']);
  });
});

describe('per-player participation', () => {
  it('Marino case: 9 games then 17 missed — barely counted for Next Week, discounted for the playoffs', () => {
    const p = playerParticipation(seq('x'.repeat(9) + '.'.repeat(17)), model)!;
    expect(p).toMatchObject({ teamGames: 26, played: 9, streak: 17 });
    expect(p.roleRate).toBeGreaterThan(0.9); // while available he dressed every game
    expect(p.nextWeek).toBeLessThan(0.15);
    expect(p.playoffs).toBeCloseTo(p.roleRate * 0.9 * 0.35, 3);
  });

  it('MacKinnon case: a 4-game absence is a short miss — not a poor playoff target', () => {
    const p = playerParticipation(seq('x'.repeat(22) + '....'), model)!;
    expect(p.streak).toBe(4);
    expect(p.playoffs).toBeGreaterThan(0.75);
    expect(p.nextWeek).toBeLessThan(p.playoffs); // Next Week is sensitive to the current absence
  });

  it('a player back from a long absence is not penalised for it', () => {
    const p = playerParticipation(seq('xx' + '.'.repeat(20) + 'xxx'), model)!;
    expect(p.streak).toBe(0);
    expect(p.roleRate).toBeGreaterThan(0.9);
    expect(p.nextWeek).toBeGreaterThan(0.9);
    expect(p.playoffs).toBeGreaterThan(0.8);
  });

  it('a part-time player who is often scratched gets a part-time rate in both periods', () => {
    const p = playerParticipation(seq('x.x.x..x.xx.x.x..x.x'), model)!;
    expect(p.roleRate).toBeGreaterThan(0.5);
    expect(p.roleRate).toBeLessThan(0.75);
    expect(p.playoffs).toBeLessThan(0.7);
  });
});

describe('fitting the model from histories', () => {
  // A population: regulars, part-timers, and players with long absences who come back (or don't).
  const pop: boolean[][] = [];
  for (let i = 0; i < 60; i++) pop.push(seq('x'.repeat(26)));
  for (let i = 0; i < 20; i++) pop.push(seq('x.xx.xx.x.xxx.x.xx.x.x.xx'));
  for (let i = 0; i < 15; i++) pop.push(seq('xxxxxx' + '.'.repeat(8) + 'xxxxxxxxxxxx'));
  for (let i = 0; i < 10; i++) pop.push(seq('xxxxx' + '.'.repeat(21)));
  const m = fitParticipation(pop);

  it('measures the factors from the data', () => {
    expect(m.samples.players).toBe(105);
    expect(m.priorRate).toBeGreaterThan(0.8);
    expect(m.availability).toBeLessThan(1);
    expect(m.nextWeekFactor['0']).toBeGreaterThan(0.9);
    expect(m.nextWeekFactor['10+']).toBeLessThan(m.nextWeekFactor['0']);
    expect(m.returnWithin10['0']).toBe(1); // short misses never need a return discount
    expect(m.returnWithin10['5-9']).toBeGreaterThan(0);
    expect(m.returnWithin10['5-9']).toBeLessThanOrEqual(1);
    expect(fitParticipation(pop)).toEqual(m); // deterministic
  });
});

describe('Next Week cohorts (regulars vs intermittent)', () => {
  // Regulars who miss one game come straight back; part-timers who miss one keep missing more often.
  const pop: boolean[][] = [];
  for (let i = 0; i < 80; i++) pop.push(seq('xxxxxxxx.xxxxxxxxx.xxxxxxxx'));
  for (let i = 0; i < 60; i++) pop.push(seq('xx.x..x.xx..x.x..xx.x..x.x.'));
  const m = fitParticipation(pop);

  it('chooses the cutoff that best predicts the observed outcomes, from the grid', () => {
    expect(PARTICIPATION.cohortCutoffs).toContain(m.cohorts!.roleCutoff);
    const { fit } = m.cohorts!;
    expect(fit.byCutoff[String(m.cohorts!.roleCutoff)]).toBeLessThanOrEqual(Math.min(...Object.values(fit.byCutoff)));
    expect(fit.byCutoff[String(m.cohorts!.roleCutoff)]).toBeLessThan(fit.pooled); // better than one pooled factor
  });

  it('gives regulars a higher factor than intermittent players after a one-game miss', () => {
    expect(m.cohorts!.regular['1']).toBeGreaterThan(m.cohorts!.intermittent['1']);
    const regular = playerParticipation(seq('x'.repeat(24) + '.'), m)!;
    const partTime = playerParticipation(seq('x.x..x.xx..x.x..xx.x..x.'), m)!;
    expect(regular.nextWeek).toBeGreaterThan(partTime.nextWeek);
  });

  it('shrinks sparse cells toward the pooled factor', () => {
    // No regular in this population has a 10+ game streak: that cell is exactly the pooled factor.
    expect(m.cohorts!.samples.regular['10+']).toBe(0);
    expect(m.cohorts!.regular['10+']).toBe(m.nextWeekFactor['10+']);
  });
});
