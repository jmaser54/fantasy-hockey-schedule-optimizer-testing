import { describe, expect, it } from 'vitest';
import type { SkaterStatLine } from '../data/format.ts';
import { RANKING_STATS, SCALED_STATS, UNCHANGED_STATS } from '../domain/evaluator.ts';
import { formatAdjusted, formatStat, searchSkaters, STAT_GROUPS, STAT_SHORT } from './evaluatorFormat.ts';

const s = (nhlId: number, name: string, gamesPlayed: number) => ({ nhlId, name, gamesPlayed }) as SkaterStatLine;

describe('Player Evaluator formatting', () => {
  it('stat groups cover every stat except GP exactly once, and every ranking stat has a short label', () => {
    const all = STAT_GROUPS.find((g) => g.id === 'all')!.stats;
    expect([...all].sort()).toEqual([...SCALED_STATS, ...UNCHANGED_STATS].filter((k) => k !== 'gamesPlayed').sort());
    expect(new Set(all).size).toBe(all.length);
    for (const k of RANKING_STATS) expect(STAT_SHORT[k]).toBeTruthy();
  });

  it('formats values by kind', () => {
    expect(formatAdjusted(12.345)).toBe('12.3');
    expect(formatStat('shootingPct', 0.1534)).toBe('15.3%');
    expect(formatStat('faceoffWinPct', null)).toBe('—');
    expect(formatStat('toiPerGame', 1411.6)).toBe('23:32');
    expect(formatStat('toiPerGame', 605)).toBe('10:05');
    expect(formatStat('plusMinus', 4)).toBe('+4');
    expect(formatStat('plusMinus', -3)).toBe('−3');
    expect(formatStat('plusMinus', 0)).toBe('0');
    expect(formatStat('goals', 7)).toBe('7');
  });
});

describe('searchSkaters', () => {
  const pool = [s(1, 'Elias Pettersson', 20), s(2, 'Elias Pettersson', 22), s(3, 'Connor McDavid', 24), s(4, 'Connor Bedard', 15), s(5, 'Tim Stützle', 23)];
  it('matches word prefixes, accent-insensitively, most games first', () => {
    expect(searchSkaters('connor', pool, new Set()).map((x) => x.nhlId)).toEqual([3, 4]);
    expect(searchSkaters('mcd', pool, new Set()).map((x) => x.nhlId)).toEqual([3]);
    expect(searchSkaters('stutzle', pool, new Set()).map((x) => x.nhlId)).toEqual([5]);
    expect(searchSkaters('elias pet', pool, new Set()).map((x) => x.nhlId)).toEqual([2, 1]);
  });
  it('skips excluded ids and too-short queries', () => {
    expect(searchSkaters('connor', pool, new Set([3])).map((x) => x.nhlId)).toEqual([4]);
    expect(searchSkaters('c', pool, new Set())).toEqual([]);
    expect(searchSkaters('  ', pool, new Set())).toEqual([]);
  });
});
