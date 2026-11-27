/**
 * The private rolling window of game nights for Insights (stored in the private data repository, never
 * published): which nights to fetch on each run (new, correction, repair), applying fetched games, and
 * dropping nights that fall out of the window.
 */
import type { GameRecord } from './gamelog.ts';

/** 2: skater lines gained evG, ppG, shp (2026-11-28); older windows are rebuilt. */
export const WINDOW_VERSION = 2;

export interface InsightsConfig {
  /** Game nights kept in the window. */
  windowNights: number;
  /** The latest N nights are fetched again once a day to pick up corrections. */
  correctionNights: number;
  /** Eastern hour from which the daily correction fetch may run. */
  correctionHourEt: number;
  /** At most this many nights are fetched per run (paced backfill and catch-up). */
  maxNightsPerRun: number;
  /** Team PP seconds a window needs before a PP share is shown. */
  ppShareMinSeconds: number;
}
export const DEFAULT_CONFIG: InsightsConfig = { windowNights: 80, correctionNights: 3, correctionHourEt: 8, maxNightsPerRun: 10, ppShareMinSeconds: 240 };

export interface NightStatus {
  /** complete: every scheduled game stored and valid. */
  status: 'complete' | 'incomplete';
  expected: number;
  stored: number;
  firstFetchedAt: string;
  fetchedAt: string;
  /** Eastern date of the latest fetch (one correction fetch per Eastern day). */
  lastFetchDayEt: string;
  fetchCount: number;
}
export interface WindowMeta {
  version: number;
  season: string;
  updatedAt: string;
  seasonFetchedOnEt: string | null;
  /** NHL teamId → abbreviation, learned from game rows (team reports carry no abbreviation). */
  teamAbbrevs: Record<string, string>;
  nights: Record<string, NightStatus>;
}
export interface WindowState {
  meta: WindowMeta;
  nights: Record<string, Record<string, GameRecord>>;
}

export function emptyWindow(season: string): WindowState {
  return { meta: { version: WINDOW_VERSION, season, updatedAt: '', seasonFetchedOnEt: null, teamAbbrevs: {}, nights: {} }, nights: {} };
}

/** Scheduled game nights before today (Eastern), ascending, with their game ids. */
export function pastNights(games: readonly { id: string; date: string }[], todayEt: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const g of games) if (g.date < todayEt) m.set(g.date, [...(m.get(g.date) ?? []), g.id]);
  return new Map([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface NightPlan {
  fetch: string[];
  reasons: Record<string, 'missing' | 'incomplete' | 'correction'>;
  /** Nights the window should hold (the latest windowNights past nights). */
  target: string[];
}

/** Which nights to fetch this run: missing/incomplete (newest first), then due corrections, capped. */
export function planNights(state: WindowState, nights: Map<string, string[]>, todayEt: string, hourEt: number, cfg: InsightsConfig): NightPlan {
  const all = [...nights.keys()];
  const target = all.slice(-cfg.windowNights);
  const reasons: NightPlan['reasons'] = {};
  for (const d of [...target].reverse()) {
    const st = state.meta.nights[d];
    if (!st) reasons[d] = 'missing';
    else if (st.status !== 'complete') reasons[d] = 'incomplete';
  }
  if (hourEt >= cfg.correctionHourEt) {
    for (const d of target.slice(-cfg.correctionNights).reverse()) {
      const st = state.meta.nights[d];
      if (st && st.status === 'complete' && st.lastFetchDayEt < todayEt) reasons[d] = 'correction';
    }
  }
  const order = Object.keys(reasons).sort((a, b) => {
    const pa = reasons[a] === 'correction' ? 1 : 0;
    const pb = reasons[b] === 'correction' ? 1 : 0;
    return pa - pb || (a < b ? 1 : -1);
  });
  const fetch = order.slice(0, cfg.maxNightsPerRun);
  return { fetch, reasons: Object.fromEntries(fetch.map((d) => [d, reasons[d]!])), target };
}

/** Group nights into ranges of consecutive scheduled nights (one date-range query each). */
export function contiguousRanges(fetch: readonly string[], nights: Map<string, string[]>): [string, string][] {
  const all = [...nights.keys()];
  const idx = fetch.map((d) => all.indexOf(d)).filter((i) => i >= 0).sort((a, b) => a - b);
  const out: [string, string][] = [];
  for (const i of idx) {
    const last = out[out.length - 1];
    if (last && all.indexOf(last[1]) === i - 1) last[1] = all[i]!;
    else out.push([all[i]!, all[i]!]);
  }
  return out;
}

export interface ApplyResult {
  stored: number;
  corrected: number;
  incompleteNights: string[];
}

/**
 * Store fetched games for the fetched nights. A valid game replaces its stored version as a whole;
 * games not returned keep their previous version. Night status is complete only when every scheduled
 * game is stored. Nights outside the window target are dropped.
 */
export function applyFetched(
  state: WindowState,
  fetched: Map<string, GameRecord>,
  fetchedNights: readonly string[],
  nights: Map<string, string[]>,
  target: readonly string[],
  nowIso: string,
  todayEt: string,
): ApplyResult {
  let stored = 0;
  let corrected = 0;
  const incompleteNights: string[] = [];
  for (const d of fetchedNights) {
    const expected = nights.get(d) ?? [];
    const games = { ...(state.nights[d] ?? {}) };
    for (const id of expected) {
      const g = fetched.get(id);
      if (!g || g.date !== d) continue;
      if (games[id] && JSON.stringify(games[id]) !== JSON.stringify(g)) corrected++;
      games[id] = g;
      stored++;
      for (const [abbrev, teamId] of Object.entries(g.teamIds)) state.meta.teamAbbrevs[String(teamId)] = abbrev;
    }
    state.nights[d] = games;
    const prev = state.meta.nights[d];
    const n = expected.filter((id) => games[id]).length;
    const complete = expected.length > 0 && n === expected.length;
    if (!complete) incompleteNights.push(d);
    state.meta.nights[d] = {
      status: complete ? 'complete' : 'incomplete',
      expected: expected.length,
      stored: n,
      firstFetchedAt: prev?.firstFetchedAt ?? nowIso,
      fetchedAt: nowIso,
      lastFetchDayEt: todayEt,
      fetchCount: (prev?.fetchCount ?? 0) + 1,
    };
  }
  const keep = new Set(target);
  for (const d of Object.keys(state.nights)) if (!keep.has(d)) delete state.nights[d];
  for (const d of Object.keys(state.meta.nights)) if (!keep.has(d)) delete state.meta.nights[d];
  state.meta.updatedAt = nowIso;
  return { stored, corrected, incompleteNights };
}
