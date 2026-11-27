import { describe, expect, it } from 'vitest';
import { PP_PERSISTENCE, PP_RULE } from './insightsSettings.ts';
import { ppStatus, type PpGame } from './ppStatus.ts';

const TEAM = 300;
/** Games from shares (team PP 300 s each), oldest first. */
const games = (shares: readonly number[], teamPpToi = TEAM): PpGame[] => shares.map((s) => ({ ppToi: Math.round(s * teamPpToi * 1000) / 1000, teamPpToi }));
/** 20 baseline games at 0.2, then the 8-game run. Elevated means ≥ 0.35. */
const base20 = Array(20).fill(0.2) as number[];
const hist = (run: readonly number[]) => games([...base20, ...run]);
/** Six elevated of eight, latest elevated, average rise 0.1875, passes the single-game check. */
const RUN = [0.2, 0.2, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45];

describe('power-play promotion rule (6 of the last 8, latest elevated, average rise ≥ 0.15, single-game check)', () => {
  it('uses the decided settings', () => {
    expect(PP_RULE).toMatchObject({ baselineGames: 20, recentGames: 8, elevation: 0.15, minElevated: 6, latestElevated: true, minAverageRise: 0.15, singleGameCheck: true, minTeamPpSeconds: 60 });
    expect(PP_RULE.minUsableGames).toBe(PP_RULE.baselineGames + PP_RULE.recentGames);
    expect(PP_PERSISTENCE).toMatchObject({ retainedNext10: 0.87, retainedNext30: 0.77, continuedNext10: 0.68, continuedNext30: 0.7, provisional: true });
  });

  it('confirms at exactly 6 of 8 elevated with the latest elevated', () => {
    const s = ppStatus(hist(RUN), 'F');
    expect(s.state).toBe('confirmed');
    expect(s).toMatchObject({ baseline: 0.2, elevated: 6, latestElevated: true, usableGames: 28 });
  });

  it('confirms at an average rise of exactly 0.15 and not just below it', () => {
    const at = ppStatus(hist(Array(8).fill(0.35)), 'F');
    expect(at.state).toBe('confirmed');
    expect(at.rise).toBeCloseTo(0.15, 4);
    expect(ppStatus(hist(Array(8).fill(0.34)), 'F').state).not.toBe('confirmed');
  });

  it('does not confirm at 5 of 8, when the latest game is not elevated, or when the average rise is below 0.15', () => {
    expect(ppStatus(hist([0.2, 0.2, 0.2, 0.6, 0.6, 0.6, 0.6, 0.6]), 'F').state).not.toBe('confirmed'); // 5 of 8
    expect(ppStatus(hist([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.2]), 'F').state).not.toBe('confirmed'); // latest not elevated
    const low = ppStatus(hist([0.0, 0.0, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35]), 'F'); // 6 of 8 but average rise 0.0625
    expect(low.state).not.toBe('confirmed');
    expect(low.rise!).toBeLessThan(0.15);
  });

  it('rejects a run carried by one big game (single-game check)', () => {
    // Six elevated games at the threshold, one near zero, one huge game: the average clears 0.35 only with the big game.
    const s = ppStatus(hist([0.05, 0.35, 0.35, 1.0, 0.35, 0.35, 0.35, 0.35]), 'F');
    expect(s.elevated).toBe(7);
    expect(s.rise!).toBeGreaterThanOrEqual(0.15);
    expect(s.state).not.toBe('confirmed');
    // A single big game on its own never confirms.
    expect(ppStatus(hist([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 1.0]), 'F').state).not.toBe('confirmed');
  });

  it('ignores games where the team had under 60 seconds of PP time, for and against', () => {
    const run = RUN;
    const withLow = [...games(base20), ...games(run.slice(0, 4)), { ppToi: 0, teamPpToi: 59 }, { ppToi: 0, teamPpToi: 40 }, ...games(run.slice(4))];
    expect(ppStatus(withLow, 'F')).toMatchObject({ state: 'confirmed', usableGames: 28 });
    // Low-PP games don't count toward the 28 either.
    const short = [...games(base20.slice(1)), ...Array.from({ length: 5 }, () => ({ ppToi: 50, teamPpToi: 50 })), ...games(run)];
    expect(ppStatus(short, 'F')).toMatchObject({ state: 'insufficient', usableGames: 27 });
  });

  it('suppresses confirmation below 28 usable games and never uses a shorter baseline', () => {
    const run = RUN;
    for (let n = 0; n < 20; n++) {
      const s = ppStatus(games([...base20.slice(20 - n), ...run]), 'F');
      expect(s).toEqual({ state: 'insufficient', usableGames: n + 8, baseline: null, recent: null, rise: null, elevated: null, latestElevated: null });
    }
    expect(ppStatus(games([...base20, ...run]), 'F').state).toBe('confirmed');
    // Extra older history doesn't change the 20-game baseline: only the 20 games before the run count.
    expect(ppStatus(games([0.9, 0.9, 0.9, ...base20, ...run]), 'F')).toMatchObject({ state: 'confirmed', baseline: 0.2 });
  });

  it('never confirms a defenceman; his rise is only observed', () => {
    const run = RUN;
    expect(ppStatus(hist(run), 'D').state).toBe('observed');
  });

  it('labels a smaller recent rise as observed, and steady usage as none', () => {
    expect(ppStatus(hist([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.4, 0.4]), 'F').state).toBe('observed');
    expect(ppStatus(hist(Array(8).fill(0.2)), 'F').state).toBe('none');
  });

  it('keeps false alerts on shuffled, role-less histories at or below 5%', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let alerted = 0;
    const N = 400;
    for (let p = 0; p < N; p++) {
      const m = 0.05 + rnd() * 0.6;
      // A noisy but stable role over 60 games (no change), shuffled.
      const shares = Array.from({ length: 60 }, () => Math.max(0, Math.min(1, m + (rnd() - 0.5) * 0.5)));
      for (let i = shares.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shares[i], shares[j]] = [shares[j]!, shares[i]!]; }
      let any = false;
      for (let t = 28; t <= shares.length && !any; t++) any = ppStatus(games(shares.slice(0, t)), 'F').state === 'confirmed';
      if (any) alerted++;
    }
    expect(alerted / N).toBeLessThanOrEqual(0.05);
  });
});
