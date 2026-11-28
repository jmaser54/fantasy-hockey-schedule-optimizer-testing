import { describe, expect, it } from 'vitest';
import { buildScale, valuePerGame } from './insightsValue.ts';
import type { SkaterCategory } from './scoring.ts';

const row = (o: Partial<Record<SkaterCategory, number>>) => ({ g: 0.2, a: 0.3, pts: 0.5, ppp: 0.1, shp: 0, sog: 2, hit: 1, blk: 1, pim: 0.4, pm: 0, fow: 0, ...o }) as Record<SkaterCategory, number | null>;
// A pool with plus/minus spread both sides of zero (forwards and defencemen).
const pool = [-0.6, -0.3, -0.1, 0, 0.1, 0.2, 0.4, 0.5].map((pm, i) => row({ pm, g: 0.1 + i * 0.03, blk: i % 2 ? 1.8 : 0.5 }));

describe('plus/minus valuation (2026-11-28)', () => {
  const scale = buildScale(pool, ['g', 'pm']);

  it('is neutral at zero: a 0 plus/minus adds nothing, positive adds, negative subtracts', () => {
    const base = valuePerGame(row({ g: 0.3, pm: 0 }), scale)!;
    expect(base).toBeCloseTo(0.3 / scale.sd.g!, 9);
    expect(valuePerGame(row({ g: 0.3, pm: 0.2 }), scale)! - base).toBeCloseTo(0.2 / scale.sd.pm!, 9);
    expect(valuePerGame(row({ g: 0.3, pm: -0.2 }), scale)! - base).toBeCloseTo(-0.2 / scale.sd.pm!, 9);
    expect('lo' in scale).toBe(false); // no floor anywhere
  });

  it('gives no value just for playing: a player with nothing expected is worth 0 in a plus/minus league', () => {
    expect(valuePerGame(row({ g: 0, pm: 0 }), scale)).toBe(0);
    expect(valuePerGame(row({ pm: 0 }), buildScale(pool, ['pm']))).toBe(0);
  });

  it('treats forwards and defencemen alike, and benches (0) a net-negative player instead of going below zero', () => {
    const fwd = valuePerGame(row({ g: 0.35, blk: 0.5, pm: -0.3 }), buildScale(pool, ['g', 'blk', 'pm']))!;
    const def = valuePerGame(row({ g: 0.1, blk: 1.8, pm: 0.4 }), buildScale(pool, ['g', 'blk', 'pm']))!;
    expect(fwd).toBeGreaterThan(0);
    expect(def).toBeGreaterThan(0);
    expect(valuePerGame(row({ pm: -0.5 }), buildScale(pool, ['pm']))).toBe(0);
  });
});
