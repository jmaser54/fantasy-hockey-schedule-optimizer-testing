/**
 * Insights settings shared by the data pipeline and the app (docs/PROJECT_SOURCE_OF_TRUTH.md §J).
 *
 * Every number here comes from the one-season (2025-26) historical studies or is labelled an
 * assumption. All are PROVISIONAL: they are re-measured on the live window during the season and
 * changed here, never hard-coded elsewhere.
 */

/** Forward/defence group used by the measured settings. */
export type PosGroup = 'F' | 'D';

/**
 * Power-play promotion rule (owner decisions 2026-11-27/28). Applied to a player's usable games only
 * (his team had at least `minTeamPpSeconds` of PP time); each game's share is player PP ÷ team PP,
 * capped at 1.
 */
export const PP_RULE = {
  minTeamPpSeconds: 60,
  /** Baseline: mean share over the `baselineGames` usable games before the recent run. Never shortened. */
  baselineGames: 20,
  /** The recent run: the latest `recentGames` usable games. */
  recentGames: 8,
  /** A game is elevated when its share is at least baseline + `elevation`. */
  elevation: 0.15,
  /** At least this many of the recent games are elevated. */
  minElevated: 6,
  /** The most recent usable game must be elevated. */
  latestElevated: true,
  /** Mean of the run minus the baseline must be at least this. */
  minAverageRise: 0.15,
  /** Single-game check (option A, decided 2026-11-28): the run's mean without its biggest game still clears baseline + elevation. */
  singleGameCheck: true,
  /** The studied rule only counted promotions from a baseline at or below this share. */
  maxBaseline: 0.7,
  /** Confirmation needs baselineGames + recentGames usable games; with fewer it is suppressed, never weakened. */
  minUsableGames: 28,
  /** Only forwards can be confirmed; defencemen's changes are supporting evidence only. */
  confirmableGroups: ['F'] as readonly PosGroup[],
} as const;

/**
 * Persistence after a confirmed forward promotion (2025-26, exact adopted rule with the single-game
 * check). Two different quantities, kept apart on purpose:
 * - `retained*`: the typical (median) share of the increase that remained. Used for VALUATION only.
 * - `continued*`: how often at least half the increase remained. Used for EVIDENCE WORDING only and
 *   never multiplied into value (that would discount the same thing twice).
 */
export const PP_PERSISTENCE = {
  retainedNext10: 0.87,
  retainedNext30: 0.77,
  continuedNext10: 0.68,
  continuedNext30: 0.7,
  provisional: true,
} as const;

/**
 * Talent half-trust, in games: the number of current-season games at which current-season numbers
 * carry as much weight as the baseline (weight = games ÷ (games + halfTrust)). Measured on 2025-26
 * (best-predicting blend of a 30-game sample with the previous season for the next 30 games), except
 * where marked as an assumption.
 */
export const TALENT_HALF_TRUST: Record<'evPts' | 'ppPts' | 'shPts' | 'goals' | 'sog' | 'hit' | 'blk' | 'pim' | 'pm' | 'fow', Record<PosGroup, number>> = {
  evPts: { F: 30, D: 30 },
  ppPts: { F: 60, D: 45 },
  shPts: { F: 25, D: 30 },
  goals: { F: 45, D: 45 },
  sog: { F: 25, D: 16 },
  hit: { F: 12, D: 12 },
  blk: { F: 40, D: 25 },
  pim: { F: 100, D: 70 },
  pm: { F: 40, D: 40 },
  /** Assumption: faceoff wins were not studied (season totals only). */
  fow: { F: 15, D: 15 },
};

/**
 * Opportunity half-trust, in games, for expected minutes: recent games dominate (measured: even-strength
 * minutes about 2–3, power-play share about 1, total minutes about 5). Short-handed minutes were not
 * studied (assumption: 3).
 */
export const MINUTES_HALF_TRUST = { evToi: 2, ppShare: 1, shToi: 3, toi: 5 } as const;
/** Recent games used for Next Week expected minutes. */
export const RECENT_MINUTES_GAMES = 10;
/** Previous-season baseline needs at least this many games; otherwise players at his position. */
export const PRIOR_MIN_GAMES = 20;

/**
 * Typical error of a blended per-game rate over the next 30 games (2025-26, mean absolute error of the
 * best blend at a 30-game sample). Used for the cautious-gain test: an upgrade must still be an
 * upgrade after allowing for this error. Assists use √(points² − goals²) (assumption); faceoff wins were
 * not studied (assumption).
 */
export const TYPICAL_ERROR_PER_GAME: Record<string, Record<PosGroup, number>> = {
  g: { F: 0.084, D: 0.047 },
  a: { F: 0.117, D: 0.109 },
  pts: { F: 0.144, D: 0.119 },
  ppp: { F: 0.063, D: 0.037 },
  shp: { F: 0.012, D: 0.012 },
  sog: { F: 0.292, D: 0.256 },
  hit: { F: 0.264, D: 0.25 },
  blk: { F: 0.131, D: 0.275 },
  pim: { F: 0.197, D: 0.182 },
  pm: { F: 0.214, D: 0.275 },
  fow: { F: 0.5, D: 0.05 },
};

/** Insights data older than this is stale: no player evidence is shown from it. */
export const INSIGHTS_FRESH_MS = 48 * 3600 * 1000;

/**
 * Ownership ranking weights by the confirmed internal tiers (never shown, never a filter). Missing or
 * stale ownership is neutral: the middle weight, no bonus and no penalty. The weights themselves are an
 * assumption (not measured): strong enough that a widely owned star doesn't outrank a clearly useful
 * low-owned player, without excluding anyone.
 */
export const OWNERSHIP_WEIGHTS = {
  skater: { lowBelow: 10, midBelow: 30 },
  goalie: { lowBelow: 20, midBelow: 40 },
  low: 1,
  mid: 0.6,
  high: 0.3,
  neutral: 0.6,
} as const;

/** Custom Insights: cards shown before See All, and the internal maximum ranked. */
export const CUSTOM_SHOWN = 3;
export const CUSTOM_MAX = 5;
