import { describe, expect, it } from 'vitest';
import { PP_PERSISTENCE, SITUATION_MINUTES_PER_GAME, TALENT_HALF_TRUST } from '../../domain/insightsSettings.ts';
import type { SkaterLine } from './gamelog.ts';
import { choosePrior, goalieStartFacts, halfTrustMinutes, shrinkByMinutes, skaterFeatures, talentRates, type SeasonTotals, type WindowAppearance } from './insightsFeatures.ts';

const TEAM_PP = 300;
/** One appearance: ice time in minutes, PP share of a 300-second team PP. */
function app(date: string, o: { ev?: number; share?: number; team?: number } = {}): WindowAppearance {
  const ev = (o.ev ?? 13) * 60;
  const team = o.team ?? TEAM_PP;
  const pp = Math.round((o.share ?? 0.2) * team);
  const line: SkaterLine = ['BOS', 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0, 0, ev + pp + 60, ev, pp, 60, 0, 0, 0];
  return { date, line, teamPpToi: team };
}
const day = (i: number) => `2026-${String(10 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
/** Appearances newest first from per-game options listed oldest first. */
const history = (opts: { ev?: number; share?: number; team?: number }[]) => opts.map((o, i) => app(day(i), o)).reverse();
const season: SeasonTotals = { gp: 30, g: 8, evG: 6, ppG: 2, shG: 0, evPts: 14, ppPts: 6, shPts: 0, sog: 60, hit: 30, blk: 15, pim: 6, pm: 2, fow: 0, toi: 30 * 16 * 60, evToi: 30 * 13 * 60, ppToi: 30 * 60, shToi: 30 * 60, ppSharePg: 0.2 };
const posMinutes = { toi: 15, evToi: 12.5, shToi: 0.8, ppShare: 0.3 };
const feats = (apps: WindowAppearance[], group: 'F' | 'D' = 'F', current: SeasonTotals | undefined = season) =>
  skaterFeatures({ apps, group, current, previous: undefined, posAvg: {}, posMinutes, teamDates: apps.map((a) => a.date) });

describe('expected minutes and the power-play status', () => {
  const confirmedRun = [...Array(30).fill({ share: 0.2 }), { share: 0.2 }, { share: 0.2 }, ...Array(6).fill({ share: 0.45 })];

  it('values a confirmed forward promotion with the retained share only (10-game for Next Week, 30-game for the playoffs)', () => {
    const f = feats(history(confirmedRun));
    expect(f.pp.state).toBe('confirmed');
    const { baseline, rise } = f.pp;
    expect(f.minutes.nextWeek.ppShare).toBeCloseTo(baseline! + PP_PERSISTENCE.retainedNext10 * rise!, 3);
    expect(f.minutes.playoffs.ppShare).toBeCloseTo(baseline! + PP_PERSISTENCE.retainedNext30 * rise!, 3);
  });

  it('never lets the chance of the role continuing change value', () => {
    const p = PP_PERSISTENCE as { continuedNext10: number; continuedNext30: number };
    const before = feats(history(confirmedRun)).minutes;
    const saved = [p.continuedNext10, p.continuedNext30];
    p.continuedNext10 = 0.01;
    p.continuedNext30 = 0.01;
    try {
      expect(feats(history(confirmedRun)).minutes).toEqual(before);
    } finally {
      [p.continuedNext10, p.continuedNext30] = saved as [number, number];
    }
  });

  it('lets recent PP minutes inform Next Week before confirmation, with no promotion status', () => {
    // Only 12 games of history: confirmation is impossible, but the recent rise still moves Next Week.
    const f = feats(history([...Array(6).fill({ share: 0.2 }), ...Array(6).fill({ share: 0.5 })]));
    expect(f.pp.state).toBe('insufficient');
    expect(f.minutes.nextWeek.ppShare).toBeGreaterThan(0.35);
    // An observed (unconfirmed) rise counts at his baseline for the playoffs.
    const o = feats(history([...Array(30).fill({ share: 0.2 }), ...Array(5).fill({ share: 0.2 }), { share: 0.45 }, { share: 0.45 }, { share: 0.45 }]));
    expect(o.pp.state).toBe('observed');
    expect(o.minutes.nextWeek.ppShare).toBeGreaterThan(o.minutes.playoffs.ppShare);
    expect(o.minutes.playoffs.ppShare).toBeCloseTo(o.pp.baseline!, 4);
  });

  it('never confirms a defenceman, even when every condition holds', () => {
    expect(feats(history(confirmedRun), 'D').pp.state).toBe('observed');
  });

  it('MacKinnon case: a 4-game even-strength jump moves Next Week much more than the playoffs', () => {
    const f = feats(history([...Array(30).fill({ ev: 13 }), ...Array(4).fill({ ev: 19 })]));
    expect(f.minutes.nextWeek.evToi - f.minutes.playoffs.evToi).toBeGreaterThan(1.2);
    expect(f.minutes.playoffs.evToi).toBeLessThan(14.2);
    expect(f.evMinutes).toMatchObject({ windowGames: 34 });
  });

  it('records the latest appearance and team games since, as facts', () => {
    const apps = history(Array(5).fill({}));
    const f = skaterFeatures({ apps, group: 'F', current: season, previous: undefined, posAvg: {}, posMinutes, teamDates: ['2026-11-20', '2026-11-18', ...apps.map((a) => a.date)] });
    expect(f.lastGame).toBe(apps[0]!.date);
    expect(f.teamGamesSinceLast).toBe(2);
  });
});

describe('talent rates', () => {
  // Position averages per 60 of the matching minutes (forwards), used as the baseline in these tests.
  const pos = { evPts: 1.9, ppPts: 4.4, shPts: 0.6, evG: 0.8, ppG: 1.5, shG: 0.3, hit: 3, sog: 7 };
  const typicalPp = SITUATION_MINUTES_PER_GAME.pp.F;

  it('keeps the measured game weights for a player with typical minutes in the situation', () => {
    // 30 games at exactly the typical PP minutes: weight on the current season = 30 ÷ (30 + half-trust games).
    const cur: SeasonTotals = { ...season, ppToi: 30 * typicalPp * 60, ppPts: 9 };
    const t = talentRates(cur, undefined, pos, 'F');
    const K = TALENT_HALF_TRUST.ppPts.F;
    const own = (9 * 60) / (30 * typicalPp);
    expect(t.rates.ppPts!).toBeCloseTo((30 * own + K * pos.ppPts) / (30 + K), 3);
    expect(halfTrustMinutes('ppPts', 'F')).toBeCloseTo(K * typicalPp, 6);
    // PP points per 60 PP minutes, not per 60 total minutes; shots stay per 60 of all ice time, weighted by games.
    expect(halfTrustMinutes('sog', 'F')).toBeNull();
  });

  it('Matthew Wood case: negligible short-handed minutes never produce a short-handed scoring rate', () => {
    // Last season: 71 games, 1 short-handed goal in 30 seconds of short-handed time; this season none in 10.5 minutes.
    const prev: SeasonTotals = { ...season, gp: 71, shG: 1, shPts: 1, shToi: 30 };
    const cur: SeasonTotals = { ...season, gp: 22, shG: 0, shPts: 0, shToi: 633 };
    const t = talentRates(cur, prev, pos, 'F');
    expect(t.prior).toBe('player');
    expect(t.rates.shG!).toBeLessThanOrEqual(pos.shG); // was 121 per 60 before the fix
    expect(t.rates.shPts!).toBeLessThanOrEqual(pos.shPts);
    // Even a full 0.5 short-handed minutes a game projects well under 0.01 short-handed goals a game.
    expect((t.rates.shG! * 0.5) / 60).toBeLessThan(0.01);
    // Seconds of time are below the reliability floor: that season isn't used for the situation at all.
    expect(shrinkByMinutes(1, 30, halfTrustMinutes('shG', 'F')!, pos.shG)).toBe(pos.shG);
  });

  it('shrinks a small PP sample toward the baseline by its minutes, the same way as short-handed', () => {
    // 1 PP point in 3 PP minutes (20 per 60 raw) is below the reliability floor: the baseline stands.
    expect(talentRates({ ...season, gp: 25, ppPts: 1, ppToi: 180 }, undefined, pos, 'F').rates.ppPts).toBe(pos.ppPts);
    // 2 PP points in 20 PP minutes (6 per 60 raw) counts, but only by its minutes.
    const r = talentRates({ ...season, gp: 25, ppPts: 2, ppToi: 1200 }, undefined, pos, 'F').rates.ppPts!;
    const M = halfTrustMinutes('ppPts', 'F')!;
    expect(r).toBeCloseTo(((2 + (M * pos.ppPts) / 60) / (20 + M)) * 60, 4);
    expect(r).toBeLessThan(pos.ppPts + 0.3);
    // A large sample keeps most of its own rate.
    const big: SeasonTotals = { ...season, gp: 80, ppPts: 30, ppToi: 80 * 3.5 * 60 };
    const own = (30 * 60) / (80 * 3.5);
    expect(talentRates(big, undefined, pos, 'F').rates.ppPts!).toBeGreaterThan(pos.ppPts + 0.6 * (own - pos.ppPts));
  });

  it('falls back to the season before last when last season is too short (Barkov case), never pooling seasons', () => {
    const cur: SeasonTotals = { ...season, gp: 3, evPts: 3, evToi: 3 * 12 * 60 };
    const short: SeasonTotals = { ...season, gp: 4, evPts: 1, evToi: 4 * 12 * 60 };
    const full: SeasonTotals = { ...season, gp: 75, evPts: 60, evToi: 75 * 15 * 60, sog: 220, toi: 75 * 19 * 60 };
    const t = talentRates(cur, short, pos, 'F', full);
    expect(t.prior).toBe('player2');
    expect(choosePrior(short, full).season).toBe(full);
    // His older full season, not the position average, drives the rate.
    const own2 = (60 * 60) / (75 * 15);
    expect(t.rates.evPts!).toBeGreaterThan(pos.evPts + 0.5 * (own2 - pos.evPts));
    expect(t.rates.sog!).toBeGreaterThan(pos.sog);
    // Without an older season, a short season is partial evidence shrunk toward the position.
    const p = talentRates(cur, short, pos, 'F');
    expect(p.prior).toBe('partial');
    expect(choosePrior(undefined, undefined).source).toBe('position');
    expect(choosePrior({ ...season, gp: 50 }, full).source).toBe('player');
  });

  it('keeps unknowns unknown', () => {
    const t = talentRates({ ...season, hit: null }, { ...season, gp: 10, hit: null }, { hit: 3 }, 'F');
    expect(t.rates.hit).toBe(3); // current value unknown → baseline only, never 0
    expect(talentRates(undefined, undefined, {}, 'F').rates.hit).toBeNull();
  });
});

describe('goalie start facts', () => {
  it('counts verified starts against team games, newest first', () => {
    const team = ['2026-11-25', '2026-11-23', '2026-11-21', '2026-11-19', '2026-11-17'];
    expect(goalieStartFacts(['2026-11-25', '2026-11-23', '2026-11-19'], team)).toEqual({ teamGames: 5, starts: 3, last10TeamGames: 5, startsLast10: 3, consecutiveStarts: 2 });
  });
});
