/**
 * Scoring categories for Custom Insights (owner decisions 2026-11-27): separate skater and goalie
 * categories, supported categories only, all preselected, and the user must confirm them (League
 * Settings shows the amber mark until then). No weights or points scoring.
 */

export const SKATER_CATEGORIES = [
  { id: 'g', label: 'Goals' },
  { id: 'a', label: 'Assists' },
  { id: 'pts', label: 'Points' },
  { id: 'ppp', label: 'Power-play points' },
  { id: 'shp', label: 'Short-handed points' },
  { id: 'sog', label: 'Shots on goal' },
  { id: 'hit', label: 'Hits' },
  { id: 'blk', label: 'Blocked shots' },
  { id: 'pim', label: 'Penalty minutes' },
  { id: 'pm', label: 'Plus/minus' },
  { id: 'fow', label: 'Faceoffs won' },
] as const;
export const GOALIE_CATEGORIES = [
  { id: 'w', label: 'Wins' },
  { id: 'sv', label: 'Saves' },
  { id: 'svpct', label: 'Save percentage' },
  { id: 'gaa', label: 'Goals-against average' },
  { id: 'so', label: 'Shutouts' },
] as const;

export type SkaterCategory = (typeof SKATER_CATEGORIES)[number]['id'];
export type GoalieCategory = (typeof GOALIE_CATEGORIES)[number]['id'];

export interface ScoringSettings {
  skater: SkaterCategory[];
  goalie: GoalieCategory[];
  /** The user reviewed and saved these categories. Until then League Settings is incomplete. */
  confirmed: boolean;
}

/** Everything preselected and not yet confirmed (new and existing users alike). */
export const DEFAULT_SCORING: ScoringSettings = {
  skater: SKATER_CATEGORIES.map((c) => c.id),
  goalie: GOALIE_CATEGORIES.map((c) => c.id),
  confirmed: false,
};

const SKATER_IDS = new Set<string>(SKATER_CATEGORIES.map((c) => c.id));
const GOALIE_IDS = new Set<string>(GOALIE_CATEGORIES.map((c) => c.id));

/** Saved scoring, tolerant: unknown categories are dropped; anything malformed is the unconfirmed default. */
export function loadScoring(v: unknown): ScoringSettings {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return structuredClone(DEFAULT_SCORING);
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.skater) || !Array.isArray(o.goalie)) return structuredClone(DEFAULT_SCORING);
  const skater = SKATER_CATEGORIES.map((c) => c.id).filter((id) => (o.skater as unknown[]).includes(id));
  const goalie = GOALIE_CATEGORIES.map((c) => c.id).filter((id) => (o.goalie as unknown[]).includes(id));
  const clean = (o.skater as unknown[]).every((x) => SKATER_IDS.has(x as string)) && (o.goalie as unknown[]).every((x) => GOALIE_IDS.has(x as string));
  return { skater, goalie, confirmed: o.confirmed === true && clean && skater.length > 0 };
}

/** Scoring is complete when confirmed with at least one skater category. */
export const isScoringComplete = (s: ScoringSettings): boolean => s.confirmed && s.skater.length > 0;
