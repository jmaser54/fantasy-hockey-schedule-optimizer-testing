import { describe, expect, it } from 'vitest';
import { PP_PERSISTENCE, TALENT_HALF_TRUST } from '../../domain/insightsSettings.ts';
import type { SkaterLine } from './gamelog.ts';
import { goalieStartFacts, skaterFeatures, talentRates, type SeasonTotals, type WindowAppearance } from './insightsFeatures.ts';

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
  it('weights the current season by games ÷ (games + half-trust), each situation against its own minutes', () => {
    const prev: SeasonTotals = { ...season, gp: 80, evPts: 40, evToi: 80 * 13 * 60 };
    const t = talentRates(season, prev, {}, 'F');
    const rc = (14 * 3600) / (30 * 13 * 60);
    const rp = (40 * 3600) / (80 * 13 * 60);
    const K = TALENT_HALF_TRUST.evPts.F;
    expect(t.rates.evPts).toBeCloseTo((30 * rc + K * rp) / (30 + K), 3);
    expect(t.prior).toBe('player');
    // PP points per 60 PP minutes, not per 60 total minutes.
    expect(talentRates(season, undefined, {}, 'F').rates.ppPts).toBeCloseTo((6 * 3600) / (30 * 60), 3);
  });

  it('uses players at his position when last season had too few games, and keeps unknowns unknown', () => {
    const t = talentRates({ ...season, hit: null }, { ...season, gp: 10 }, { hit: 3 }, 'F');
    expect(t.prior).toBe('position');
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
