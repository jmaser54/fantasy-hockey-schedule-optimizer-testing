import type { PosGroup } from '../domain/insightsSettings.ts';
import type { PpStatus } from '../domain/ppStatus.ts';
import type { Game, Player, Team } from '../domain/types.ts';

/** Bump when the on-disk shape changes incompatibly. */
export const DATA_VERSION = 1;

export interface ScheduleFile {
  version: number;
  /** NHL season id, e.g. "20262027". */
  season: string;
  fetchedAt: string;
  source: string;
  teams: Team[];
  /** Regular-season games only, each listed once, dated by the NHL's (Eastern) game date. */
  games: Game[];
}

export interface PlayersFile {
  version: number;
  season: string;
  fetchedAt: string;
  sources: {
    rosters: string;
    eligibility: { source: 'espn' | 'nhl'; detail: string };
  };
  players: (Player & {
    /** Not on an NHL active roster at the latest refresh (e.g. assigned to the minors). */
    inactive?: boolean;
  })[];
}

/** Shape version of ownership.json (separate from DATA_VERSION: players.json is unchanged). */
export const OWNERSHIP_VERSION = 1;
export const OWNERSHIP_PATH = 'data/ownership.json';

/**
 * ESPN fantasy ownership for NHL players (Insights ranking signal only, never eligibility or
 * availability). Keyed by directory id "nhl-<nhlId>". A player with no entry has unknown ownership.
 */
export interface OwnershipFile {
  version: number;
  /** NHL season id, e.g. "20262027". */
  season: string;
  /** When ESPN was read. */
  fetchedAt: string;
  source: string;
  players: Record<string, { espnId: number; /** Share of ESPN leagues rostering the player, 0–100. */ pct: number }>;
}

/** Shape version of insights-inputs.json. */
export const INSIGHTS_VERSION = 2;
export const INSIGHTS_PATH = 'data/insights-inputs.json';

/** Production evidence (Talent) for a window of games. Sums; null when a game had the value missing. */
export interface TalentEvidence {
  g: number | null;
  a: number | null;
  a1: number | null;
  a2: number | null;
  pts: number | null;
  evPts: number | null;
  ppp: number | null;
  sog: number | null;
  hit: number | null;
  blk: number | null;
  pim: number | null;
  pm: number | null;
  /** Even-strength goals, power-play goals, short-handed points (version 2). */
  evG: number | null;
  ppG: number | null;
  shp: number | null;
}

/**
 * Deployment evidence (Opportunity) for a window of games, in seconds. ppShare = Σ player PP seconds ÷
 * Σ team PP seconds over the same games; null when the team had too little PP time to judge. Future
 * keys (linemates, ppUnit, teammateQuality, ozStartPct) are optional: absent means "not measured".
 */
export interface OpportunityEvidence {
  toi: number | null;
  evToi: number | null;
  ppToi: number | null;
  shToi: number | null;
  teamPpToi: number | null;
  ppShare: number | null;
  linemates?: { nhlId: number; evShared: number; ppShared: number }[];
  ppUnit?: 1 | 2 | null;
  teammateQuality?: number | null;
  ozStartPct?: number | null;
}

export interface SkaterWindow {
  gp: number;
  from: string;
  to: string;
  talent: TalentEvidence;
  opportunity: OpportunityEvidence;
}

export interface SkaterSeason {
  gp: number;
  talent: TalentEvidence;
  /** Per-game averages in seconds; ppSharePg is the NHL's share of team PP time in the games he played. */
  opportunity: { toiPg: number | null; evToiPg: number | null; ppToiPg: number | null; shToiPg: number | null; ppSharePg: number | null };
}

export interface GoalieWindow {
  gp: number;
  gs: number;
  sv: number;
  sa: number;
  ga: number;
  svPct: number | null;
  toi: number;
  w: number;
  l: number;
  otl: number;
}

/**
 * Derived evidence for future Insights (public/data/insights-inputs.json): current NHL roster players
 * only, keyed "nhl-<nhlId>", with Talent and Opportunity kept apart. Raw game lines are never published.
 */
export interface InsightsInputsFile {
  version: number;
  season: string;
  generatedAt: string;
  /** Latest game night fully stored; null before the first night is in. */
  gamesThrough: string | null;
  /** Latest night past the correction window (values not expected to change). */
  settledThrough: string | null;
  /** Complete nights held / nights wanted. Trends are usable only when complete is true. */
  windowNights: number;
  windowTarget: number;
  complete: boolean;
  settings: { ppShareMinSeconds: number; correctionNights: number };
  sources: {
    gameLogs: string;
    season: string;
    evidence: { talent: true; opportunity: { toi: boolean; ppShare: boolean; linemates: boolean; ppUnit: boolean; teammateQuality: boolean } };
  };
  players: Record<string, { team: string; last5?: SkaterWindow; last10?: SkaterWindow; window?: SkaterWindow; season?: SkaterSeason; features?: SkaterFeatures }>;
  /** League-wide context: average team PP seconds per game this season. */
  league: { ppToiPg: number | null };
  teams: Record<
    string,
    {
      season?: { gp: number; gfPg: number | null; sfPg: number | null; ppPct: number | null; ppOpp: number; ppOppPg: number | null; ppGoals: number; ppToiPg: number | null; pkPct: number | null };
      last10?: { gp: number; gf: number; sf: number; ppOpp: number; ppGoals: number; ppToi: number; ppPct: number | null };
    }
  >;
  goalies: Record<
    string,
    {
      team: string;
      lastStart: string | null;
      last5?: GoalieWindow;
      season?: GoalieWindow & { gaa: number | null };
      /** Verified starts (gamesStarted) against his current team's games in the window, newest first. */
      starts?: { teamGames: number; starts: number; last10TeamGames: number; startsLast10: number; consecutiveStarts: number };
    }
  >;
}

/** Blended Talent rates per 60 minutes of the matching situation (sog, hit, blk, pim, pm, fow: per 60 of all ice time). */
export type TalentRates = Record<'evPts' | 'ppPts' | 'shPts' | 'evG' | 'ppG' | 'shG' | 'sog' | 'hit' | 'blk' | 'pim' | 'pm' | 'fow', number | null>;

/** Expected minutes per game (ice time in minutes; ppShare = share of his team's PP time, 0–1). */
export interface ExpectedMinutes {
  toi: number;
  evToi: number;
  shToi: number;
  ppShare: number;
}

/** Derived per-skater features (computed privately from the game window; no game lines). */
export interface SkaterFeatures {
  group: PosGroup;
  rates: TalentRates;
  /** Current-season games behind the rates. */
  rateGames: number;
  /** Baseline used: his previous season, or players at his position. */
  prior: 'player' | 'position';
  minutes: { nextWeek: ExpectedMinutes; playoffs: ExpectedMinutes };
  pp: PpStatus;
  /** Even-strength minutes per game (supporting evidence only). */
  evMinutes: { last5: number | null; window: number | null; windowGames: number };
  /** Latest appearance in the window and his current team's games since then (a fact; the cause is unknown). */
  lastGame: string | null;
  teamGamesSinceLast: number | null;
  /** Points per game this season and last season (for production changes judged on full samples). */
  production: { gp: number; ptsPg: number | null; prevGp: number; prevPtsPg: number | null };
}

/** NHL skater position codes as reported by the stats API. */
export type SkaterPositionCode = 'C' | 'L' | 'R' | 'D';

/**
 * One skater's current-season regular-season totals (Player Evaluator V1).
 * Joined from the NHL Stats REST summary, realtime and faceoffwins reports.
 */
export interface SkaterStatLine {
  /** NHL player id; the same id as `Player.nhlId`. */
  nhlId: number;
  name: string;
  /** Every team this season, in the API's order (traded players have several). Not the current team. */
  teams: string[];
  position: SkaterPositionCode;
  /** Always at least 1: the API has no row for skaters who haven't played. */
  gamesPlayed: number;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  penaltyMinutes: number;
  ppPoints: number;
  shPoints: number;
  shots: number;
  hits: number;
  blockedShots: number;
  faceoffWins: number;
  /** goals / shots as a 0–1 fraction; null with no shots. */
  shootingPct: number | null;
  /** 0–1 fraction; null with no faceoffs taken. */
  faceoffWinPct: number | null;
  /** Average time on ice per game, in seconds. */
  toiPerGame: number;
}

export interface SkaterStatsFile {
  version: number;
  season: string;
  /** NHL game type; always 2 (regular season). */
  gameType: 2;
  fetchedAt: string;
  source: string;
  skaters: SkaterStatLine[];
}

/**
 * Completed regular seasons with static Player Evaluator snapshots, newest first, and their games
 * per team (both 82; the current season, 2026–27, has 84). Each is fetched once by
 * scripts/fetch-historical-stats.ts into public/data/skater-stats-<season>.json and is not part of
 * the frequent current-season refresh.
 */
export const HISTORICAL_SEASONS: readonly { season: string; teamGames: number }[] = [
  { season: '20252026', teamGames: 82 },
  { season: '20242025', teamGames: 82 },
];

/** Path (relative to the site base) of a season's skater-stats snapshot; the current season has no suffix. */
export const skaterStatsPath = (season?: string): string => (season ? `data/skater-stats-${season}.json` : 'data/skater-stats.json');
