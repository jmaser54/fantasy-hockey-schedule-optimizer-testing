import { describe, expect, it } from 'vitest';
import { PP_PERSISTENCE, PRIOR_SEASON_MINUTES_GAMES, SEASON_RELIABILITY_GAMES, SITUATION_MINUTES_PER_GAME, TALENT_HALF_TRUST } from '../../domain/insightsSettings.ts';
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

describe('prior-season minutes anchor (small-sample correction, 2026-11-28)', () => {
  const W = PRIOR_SEASON_MINUTES_GAMES;
  /** A season of gp games at the given per-game minutes (seconds stored as totals). */
  const seasonOf = (gp: number, toi: number, ev: number, sh: number): SeasonTotals => ({ ...season, gp, toi: gp * toi * 60, evToi: gp * ev * 60, shToi: gp * sh * 60, ppToi: gp * 60, ppSharePg: 0.2 });
  const featsP = (apps: WindowAppearance[], current: SeasonTotals | undefined, previous?: SeasonTotals, previous2?: SeasonTotals) =>
    skaterFeatures({ apps, group: 'F', current, previous, previous2, posAvg: {}, posMinutes, teamDates: apps.map((a) => a.date) });
  const four = history(Array(4).fill({ ev: 10, share: 0.4 })); // returner-like: 4 games this season, 11.2 total minutes
  const cur4 = seasonOf(4, 12.2, 10, 1);
  const last = seasonOf(67, 20.3, 15.5, 3.5);

  it('anchors total, even-strength and short-handed minutes in both contexts at 2 games of weight; PP share unchanged', () => {
    const base = featsP(four, cur4).minutes;
    const got = featsP(four, cur4, last).minutes;
    for (const ctx of ['nextWeek', 'playoffs'] as const) {
      expect(Math.abs(got[ctx].toi - (4 * base[ctx].toi + W * 20.3) / (4 + W))).toBeLessThanOrEqual(0.1); // minutes are rounded to 0.1
      expect(Math.abs(got[ctx].evToi - (4 * base[ctx].evToi + W * 15.5) / (4 + W))).toBeLessThanOrEqual(0.1); // minutes are rounded to 0.1
      expect(Math.abs(got[ctx].shToi - (4 * base[ctx].shToi + W * 3.5) / (4 + W))).toBeLessThanOrEqual(0.1); // minutes are rounded to 0.1
      expect(got[ctx].toi).toBeGreaterThan(base[ctx].toi);
      expect(got[ctx].ppShare).toBe(base[ctx].ppShare);
    }
  });

  it('is fixed at two games of weight (owner decision)', () => {
    expect(PRIOR_SEASON_MINUTES_GAMES).toBe(2);
  });

  it("uses this season's games played as n in both contexts, not the window or recent sample", () => {
    const twelve = history(Array(12).fill({ ev: 15, share: 0.4 }));
    const cur30 = seasonOf(30, 16, 13, 1);
    const base = featsP(twelve, cur30).minutes;
    const got = featsP(twelve, cur30, last).minutes;
    for (const ctx of ['nextWeek', 'playoffs'] as const) {
      const expected = (30 * base[ctx].toi + W * 20.3) / (30 + W);
      expect(Math.abs(got[ctx].toi - expected)).toBeLessThanOrEqual(0.1);
      // An n of 10 or 12 (recent sample or window) would land well away from it.
      expect(Math.abs(got[ctx].toi - (10 * base[ctx].toi + W * 20.3) / (10 + W))).toBeGreaterThan(0.2);
    }
  });

  it('falls back to the window games for n when there is no current-season row, and skips a missing previous-season field', () => {
    const base = featsP(four, undefined).minutes.playoffs;
    const got = featsP(four, undefined, last).minutes.playoffs;
    expect(Math.abs(got.toi - (4 * base.toi + W * 20.3) / (4 + W))).toBeLessThanOrEqual(0.1);
    const noToi = { ...last, toi: null };
    const partial = featsP(four, cur4, noToi).minutes.playoffs;
    const plain = featsP(four, cur4).minutes.playoffs;
    expect(partial.toi).toBe(plain.toi); // no previous total: total minutes not anchored
    expect(partial.evToi).toBeGreaterThan(plain.evToi); // even-strength still anchored
  });

  it('fades as this season grows, so current-season minutes keep driving the estimate', () => {
    const many = history(Array(40).fill({ ev: 10, share: 0.4 }));
    const cur40 = seasonOf(40, 12.2, 10, 1);
    const shift4 = featsP(four, cur4, last).minutes.playoffs.toi - featsP(four, cur4).minutes.playoffs.toi;
    const shift40 = featsP(many, cur40, last).minutes.playoffs.toi - featsP(many, cur40).minutes.playoffs.toi;
    expect(shift40).toBeGreaterThan(0);
    expect(shift40).toBeLessThan(shift4 / 4); // weight 2/42 vs 2/6
    const nw4 = featsP(four, cur4, last).minutes.nextWeek.toi - featsP(four, cur4).minutes.nextWeek.toi;
    const nw40 = featsP(many, cur40, last).minutes.nextWeek.toi - featsP(many, cur40).minutes.nextWeek.toi;
    expect(nw40).toBeGreaterThan(0);
    expect(nw40).toBeLessThan(nw4 / 4); // Next Week fades the same way
  });

  it('uses only a previous season with enough games (else the one before), never a partial season', () => {
    const short = seasonOf(10, 25, 20, 2);
    const base = featsP(four, cur4).minutes.playoffs.toi;
    expect(featsP(four, cur4, short).minutes.playoffs.toi).toBe(base); // 10 games: no anchor
    expect(featsP(four, cur4, short, last).minutes.playoffs.toi).toBe(featsP(four, cur4, last).minutes.playoffs.toi); // falls back to the season before
    expect(featsP(four, cur4, undefined, short).minutes.playoffs.toi).toBe(base);
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

  it('treats a short baseline season as partial evidence for PIM-type categories (Sabourin case)', () => {
    const posPim = 2.0; // forwards' PIM per 60 of ice time
    const toiPg = 9.5 * 60;
    // Last season: 26 games at 3.42 PIM a game; this season: 9 games at 1.89.
    const prev: SeasonTotals = { ...season, gp: 26, pim: 3.42 * 26, toi: 26 * toiPg };
    const cur: SeasonTotals = { ...season, gp: 9, pim: 1.89 * 9, toi: 9 * toiPg };
    const perGame = (r: number) => (r * toiPg) / 3600;
    const t = talentRates(cur, prev, { ...pos, pim: posPim }, 'F');
    expect(perGame(t.rates.pim!)).toBeLessThan(2.6); // was about 3.4 a game with the 26-game season trusted fully
    expect(perGame(t.rates.pim!)).toBeGreaterThan(1.89); // still a PIM specialist, not the position average (0.32 a game)
    // A full season keeps most of its player-specific rate.
    const full: SeasonTotals = { ...season, gp: 82, pim: 2.5 * 82, toi: 82 * toiPg };
    const own = (2.5 * 3600) / toiPg;
    const prior = talentRates(undefined, full, { ...pos, pim: posPim }, 'F').rates.pim!;
    expect(prior).toBeGreaterThan(posPim + 0.75 * (own - posPim));
    expect(SEASON_RELIABILITY_GAMES.pim).toBeCloseTo((70 * 0.24) / 0.76, 0);
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
