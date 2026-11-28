/**
 * Insights valuation: expected production per game in each scoring category = Talent rate × expected
 * minutes in the matching situation (nothing counted twice), put on one comparable scale across the
 * user's selected categories. The same player intelligence serves Next Week and the playoffs; only the
 * expected minutes differ (§J).
 */
import type { InsightsInputsFile, SkaterFeatures } from '../data/format.ts';
import { OWNERSHIP_WEIGHTS, TYPICAL_ERROR_PER_GAME, type PosGroup } from './insightsSettings.ts';
import type { SkaterCategory } from './scoring.ts';

export type InsightContext = 'nextWeek' | 'playoffs';

/** Expected amount per game in every skater category; null when neither the player nor a baseline has the rate. */
export function perGame(f: SkaterFeatures, teamPpSecondsPg: number, ctx: InsightContext): Record<SkaterCategory, number | null> {
  const m = f.minutes[ctx];
  const ev = m.evToi;
  const pp = (m.ppShare * teamPpSecondsPg) / 60;
  const sh = m.shToi;
  const r = f.rates;
  const sit = (e: number | null, p: number | null, s: number | null) => (e === null || p === null || s === null ? null : (e * ev + p * pp + s * sh) / 60);
  const g = sit(r.evG, r.ppG, r.shG);
  const pts = sit(r.evPts, r.ppPts, r.shPts);
  const tot = (v: number | null) => (v === null ? null : (v * m.toi) / 60);
  return {
    g,
    a: g === null || pts === null ? null : Math.max(0, pts - g),
    pts,
    ppp: r.ppPts === null ? null : (r.ppPts * pp) / 60,
    shp: r.shPts === null ? null : (r.shPts * sh) / 60,
    sog: tot(r.sog),
    hit: tot(r.hit),
    blk: tot(r.blk),
    pim: tot(r.pim),
    pm: tot(r.pm),
    fow: tot(r.fow),
  };
}

/** Team PP seconds per game for a team (season), falling back to the league average, then 4 minutes. */
export function teamPpSeconds(file: InsightsInputsFile, team: string): number {
  return file.teams[team]?.season?.ppToiPg ?? file.league.ppToiPg ?? 240;
}

/** Per selected category: the spread of expected per-game amounts across regular skaters. */
export interface CategoryScale {
  cats: SkaterCategory[];
  sd: Partial<Record<SkaterCategory, number>>;
}

/**
 * "How far from a typical player, in that category's usual spread": each category is divided by the
 * spread across skaters with at least 10 games this season, so 1 hit and 1 goal become comparable and
 * selected categories count equally. Every category is measured from zero, which is also the neutral
 * point for plus/minus (2026-11-28: the earlier floor at the pool minimum gave every player about 3 value
 * points a game just for playing).
 */
export function buildScale(pool: readonly Record<SkaterCategory, number | null>[], cats: readonly SkaterCategory[]): CategoryScale {
  const sd: CategoryScale['sd'] = {};
  for (const c of cats) {
    const v = pool.map((p) => p[c]).filter((x): x is number => x !== null);
    if (v.length < 2) continue;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
    if (!(s > 0)) continue;
    sd[c] = s;
  }
  return { cats: cats.filter((c) => sd[c] !== undefined), sd };
}

/**
 * Value per game on the common scale. Plus/minus counts with its sign (a negative expectation lowers the
 * value); the other categories can't be negative. A player whose expected contribution is negative
 * overall is worth 0, as you would bench him rather than start him; this also keeps values non-negative,
 * which the add/drop search relies on. A category with an unknown amount makes the value unknown.
 */
export function valuePerGame(pg: Record<SkaterCategory, number | null>, scale: CategoryScale): number | null {
  let v = 0;
  for (const c of scale.cats) {
    const x = pg[c];
    if (x === null) return null;
    v += (c === 'pm' ? x : Math.max(0, x)) / scale.sd[c]!;
  }
  return Math.max(0, v);
}

/** Measured typical error of one player's per-game value on the same scale (categories combined as independent). */
export function errorPerGame(group: PosGroup, scale: CategoryScale): number {
  let s = 0;
  for (const c of scale.cats) {
    const e = TYPICAL_ERROR_PER_GAME[c]?.[group] ?? 0;
    s += (e / scale.sd[c]!) ** 2;
  }
  return Math.sqrt(s);
}

/** Ownership ranking weight by internal tier; missing or stale ownership (undefined here) is neutral (1.0). */
export function ownershipWeight(pct: number | undefined, goalie = false): number {
  if (pct === undefined) return OWNERSHIP_WEIGHTS.neutral;
  const t = goalie ? OWNERSHIP_WEIGHTS.goalie : OWNERSHIP_WEIGHTS.skater;
  return pct < t.lowBelow ? OWNERSHIP_WEIGHTS.low : pct < t.midBelow ? OWNERSHIP_WEIGHTS.mid : OWNERSHIP_WEIGHTS.high;
}
