import type { BenchmarkChoice } from '../domain/evaluator.ts';

/**
 * Player Evaluator preferences: comparison players and the selected benchmark. Kept in their own
 * browser-storage key, separate from the saved fantasy roster (`playoff-optimizer:v1`), so changing
 * them never touches the roster and the roster's persistence model is unchanged. The live and testing
 * sites share one browser storage, so the testing build uses its own key, as for the app state.
 *
 * The default roster-max benchmark is stored as that choice, never as a GP number, so it keeps
 * following the roster. A custom benchmark is stored as the user's number; its upper limit is checked
 * when it is resolved against the current season.
 */
export function evaluatorPrefsKeyFor(baseUrl: string): string {
  return /\/fantasy-hockey-schedule-optimizer-testing\/$/.test(baseUrl) ? 'playoff-evaluator-testing:v1' : 'playoff-evaluator:v1';
}
export const EVALUATOR_PREFS_KEY = evaluatorPrefsKeyFor((import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/');
export const EVALUATOR_PREFS_VERSION = 1;

export interface EvaluatorPrefs {
  version: number;
  /** NHL ids of comparison players, in the order added. Not part of the fantasy roster. */
  comparisons: number[];
  benchmark: BenchmarkChoice;
}

export function defaultEvaluatorPrefs(): EvaluatorPrefs {
  return { version: EVALUATOR_PREFS_VERSION, comparisons: [], benchmark: { kind: 'roster-max' } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function loadBenchmark(v: unknown): BenchmarkChoice | undefined {
  if (!isObj(v)) return undefined;
  if (v.kind === 'roster-max') return { kind: 'roster-max' };
  if (v.kind === 'player' && isId(v.nhlId)) return { kind: 'player', nhlId: v.nhlId };
  if (v.kind === 'custom' && Number.isInteger(v.gamesPlayed) && (v.gamesPlayed as number) >= 1) return { kind: 'custom', gamesPlayed: v.gamesPlayed as number };
  return undefined;
}

/** Tolerant: anything unreadable falls back to the defaults, field by field. */
export function parseEvaluatorPrefs(raw: string | null): EvaluatorPrefs {
  const base = defaultEvaluatorPrefs();
  if (!raw) return base;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!isObj(data)) return base;
  const comparisons = Array.isArray(data.comparisons) ? [...new Set(data.comparisons.filter(isId))] : base.comparisons;
  return { ...base, comparisons, benchmark: loadBenchmark(data.benchmark) ?? base.benchmark };
}

export function serializeEvaluatorPrefs(prefs: EvaluatorPrefs): string {
  return JSON.stringify({ version: EVALUATOR_PREFS_VERSION, comparisons: prefs.comparisons, benchmark: prefs.benchmark });
}

export function loadEvaluatorPrefs(key = EVALUATOR_PREFS_KEY): EvaluatorPrefs {
  try {
    return parseEvaluatorPrefs(globalThis.localStorage?.getItem(key) ?? null);
  } catch {
    return defaultEvaluatorPrefs();
  }
}

export function saveEvaluatorPrefs(prefs: EvaluatorPrefs, key = EVALUATOR_PREFS_KEY): boolean {
  try {
    globalThis.localStorage?.setItem(key, serializeEvaluatorPrefs(prefs));
    return true;
  } catch {
    return false;
  }
}
