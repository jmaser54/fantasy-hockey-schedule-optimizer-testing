/**
 * Insights data refresh (V1). Run by the `insights` job of .github/workflows/refresh-data.yml after the
 * main refresh, with the private data repository (jmaser54/playoff-planner-data) checked out at
 * INSIGHTS_STATE_DIR's parent. Keeps a rolling window of game nights there (never in this public
 * repository) and writes the derived public/data/insights-inputs.json.
 *
 *   npm run data:insights
 *
 * Logs only counts and dates: no game lines, no player values. Never blocks the main refresh: on any
 * failure the previous files stay as they were.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { InsightsInputsFile, PlayersFile, ScheduleFile, SkaterStatsFile } from '../src/data/format.ts';
import { assembleGames, fetchRange, GAME_REPORTS, type GameRecord, type GameReport } from '../src/data/pipeline/gamelog.ts';
import { buildInsightsInputs, FEATURES_REVISION, fetchSeasonData, insightsUpdateProblems, type SeasonData } from '../src/data/pipeline/insightsInputs.ts';
import { applyFetched, contiguousRanges, DEFAULT_CONFIG, emptyWindow, pastNights, planNights, WINDOW_VERSION, type InsightsConfig, type WindowState } from '../src/data/pipeline/insightsWindow.ts';

const SEASON = process.env.SEASON ?? '20262027';
const STATE_ROOT = process.env.INSIGHTS_STATE_DIR ?? '.insights-state/testing';
const STATE_DIR = `${STATE_ROOT}/${SEASON}`;
const OUT = 'public/data/insights-inputs.json';
const DELAY_MS = Number(process.env.INSIGHTS_REQUEST_DELAY_MS ?? 400);
const envNum = (name: string, def: number) => (process.env[name] !== undefined && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : def);
const CFG: InsightsConfig = {
  windowNights: envNum('INSIGHTS_WINDOW_NIGHTS', DEFAULT_CONFIG.windowNights),
  correctionNights: envNum('INSIGHTS_CORRECTION_NIGHTS', DEFAULT_CONFIG.correctionNights),
  correctionHourEt: envNum('INSIGHTS_CORRECTION_HOUR_ET', DEFAULT_CONFIG.correctionHourEt),
  maxNightsPerRun: envNum('INSIGHTS_MAX_NIGHTS_PER_RUN', DEFAULT_CONFIG.maxNightsPerRun),
  ppShareMinSeconds: envNum('INSIGHTS_PP_SHARE_MIN_SECONDS', DEFAULT_CONFIG.ppShareMinSeconds),
};

const log = (s: string) => console.log(s);
const warn = (s: string) => {
  log(`warning: ${s}`);
  console.log(`::warning title=Insights data::${s.replace(/\s+/g, ' ').slice(0, 300)}`);
};
let requests = 0;

async function getJson(url: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      requests++;
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'fantasy-playoff-optimizer insights refresh' } });
      await new Promise((r) => setTimeout(r, DELAY_MS));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const easternParts = (d = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};
const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

async function loadState(): Promise<{ state: WindowState; season: SeasonData | undefined }> {
  const meta = await readJson<WindowState['meta']>(`${STATE_DIR}/meta.json`);
  if (!meta || meta.version !== WINDOW_VERSION || meta.season !== SEASON) {
    if (meta) log(`Insights: window format/season changed (${meta.version}/${meta.season}); rebuilding`);
    return { state: emptyWindow(SEASON), season: undefined };
  }
  const state: WindowState = { meta, nights: {} };
  for (const d of Object.keys(meta.nights)) state.nights[d] = (await readJson<Record<string, GameRecord>>(`${STATE_DIR}/nights/${d}.json`)) ?? {};
  // A night file that went missing makes that night incomplete, so it is fetched again.
  for (const [d, st] of Object.entries(meta.nights)) if (Object.keys(state.nights[d]!).length !== st.stored) st.status = 'incomplete';
  return { state, season: await readJson<SeasonData>(`${STATE_DIR}/season.json`) };
}

async function saveState(state: WindowState, season: SeasonData | undefined, written: readonly string[]) {
  await mkdir(`${STATE_DIR}/nights`, { recursive: true });
  for (const d of written) if (state.nights[d]) await writeFile(`${STATE_DIR}/nights/${d}.json`, JSON.stringify(state.nights[d]));
  for (const f of await readdir(`${STATE_DIR}/nights`)) if (!state.meta.nights[f.replace(/\.json$/, '')]) await rm(`${STATE_DIR}/nights/${f}`);
  if (season) await writeFile(`${STATE_DIR}/season.json`, JSON.stringify(season));
  await writeFile(`${STATE_DIR}/meta.json`, JSON.stringify(state.meta, null, 1));
  // Season rollover: other seasons' folders are removed (their history is not needed).
  for (const f of await readdir(STATE_ROOT)) if (/^\d{8}$/.test(f) && f !== SEASON) {
    await rm(`${STATE_ROOT}/${f}`, { recursive: true });
    log(`Insights: removed the old season folder ${f}`);
  }
}

async function main() {
  const root = STATE_ROOT.split('/')[0]!;
  if (!existsSync(root)) {
    log(`Insights: private data repository not checked out (${root}); nothing done`);
    return;
  }
  await mkdir(STATE_DIR, { recursive: true });
  const nowIso = new Date().toISOString();
  const { day: todayEt, hour: hourEt } = easternParts();
  const schedule = await readJson<ScheduleFile>('public/data/schedule.json');
  const players = await readJson<PlayersFile>('public/data/players.json');
  const skaterStats = await readJson<SkaterStatsFile>('public/data/skater-stats.json');
  if (!schedule || !players || schedule.season !== SEASON) throw new Error('schedule.json / players.json missing or for another season');
  let { state, season } = await loadState();
  const nights = pastNights(schedule.games, todayEt);
  const plan = planNights(state, nights, todayEt, hourEt, CFG);
  const reasons = Object.values(plan.reasons);
  log(`Insights: ${todayEt} ${hourEt}h ET; window ${Object.values(state.meta.nights).filter((n) => n.status === 'complete').length}/${plan.target.length} nights complete; fetching ${plan.fetch.length} nights (missing ${reasons.filter((r) => r === 'missing').length}, incomplete ${reasons.filter((r) => r === 'incomplete').length}, correction ${reasons.filter((r) => r === 'correction').length})`);

  const written: string[] = [];
  let changed = false;
  for (const [from, to] of contiguousRanges(plan.fetch, nights)) {
    const inRange = plan.fetch.filter((d) => d >= from && d <= to);
    try {
      const rows = {} as Record<GameReport, Record<string, unknown>[]>;
      for (const r of Object.keys(GAME_REPORTS) as GameReport[]) rows[r] = await fetchRange(getJson, r, from, to);
      const { games, rejected } = assembleGames(rows);
      const res = applyFetched(state, games, inRange, nights, plan.target, nowIso, todayEt);
      written.push(...inRange);
      changed = true;
      log(`Insights: ${from}..${to}: ${games.size} valid games, ${rejected.length} rejected, ${res.stored} stored, ${res.corrected} corrected; incomplete nights ${res.incompleteNights.length ? res.incompleteNights.join(',') : 'none'}`);
      for (const r of rejected.slice(0, 5)) log(`  rejected ${r.gameId}: ${r.reason}`);
    } catch (err) {
      warn(`fetch ${from}..${to} failed; window unchanged for those nights: ${(err as Error).message}`);
    }
  }
  // Drop nights that left the window even when nothing was fetched.
  const before = Object.keys(state.meta.nights).length;
  applyFetched(state, new Map(), [], nights, plan.target, state.meta.updatedAt || nowIso, todayEt);
  if (Object.keys(state.meta.nights).length !== before) changed = true;

  if (state.meta.seasonFetchedOnEt !== todayEt || !season) {
    try {
      season = await fetchSeasonData(getJson, SEASON, nowIso);
      state.meta.seasonFetchedOnEt = todayEt;
      changed = true;
      log(`Insights: season reports: ${Object.keys(season.skaters).length} skaters, ${Object.keys(season.teams).length} teams, ${Object.keys(season.goalies).length} goalies`);
    } catch (err) {
      warn(`season reports failed; kept the previous season data: ${(err as Error).message}`);
    }
  }

  // The previous season (the Talent baseline): fetched once and kept in the private repository.
  const PREV = `${Number(SEASON.slice(0, 4)) - 1}${SEASON.slice(0, 4)}`;
  let previousSeason = await readJson<SeasonData & { season?: string }>(`${STATE_DIR}/past-season.json`);
  if (!previousSeason || previousSeason.season !== PREV) {
    try {
      previousSeason = { ...(await fetchSeasonData(getJson, PREV, nowIso)), season: PREV };
      await writeFile(`${STATE_DIR}/past-season.json`, JSON.stringify(previousSeason));
      changed = true;
      log(`Insights: previous season ${PREV}: ${Object.keys(previousSeason.skaters).length} skaters`);
    } catch (err) {
      previousSeason = undefined;
      warn(`previous season reports failed; Talent baselines fall back to position averages: ${(err as Error).message}`);
    }
  }
  const previousSkaterStats = await readJson<SkaterStatsFile>(`public/data/skater-stats-${PREV}.json`);
  // The season before that (baseline when last season is too short), also fetched once.
  const PREV2 = `${Number(SEASON.slice(0, 4)) - 2}${Number(SEASON.slice(0, 4)) - 1}`;
  let previousSeason2 = await readJson<SeasonData & { season?: string }>(`${STATE_DIR}/past-season-2.json`);
  if (!previousSeason2 || previousSeason2.season !== PREV2) {
    try {
      previousSeason2 = { ...(await fetchSeasonData(getJson, PREV2, nowIso)), season: PREV2 };
      await writeFile(`${STATE_DIR}/past-season-2.json`, JSON.stringify(previousSeason2));
      changed = true;
      log(`Insights: season before last ${PREV2}: ${Object.keys(previousSeason2.skaters).length} skaters`);
    } catch (err) {
      previousSeason2 = undefined;
      warn(`season-before-last reports failed; that baseline is unavailable: ${(err as Error).message}`);
    }
  }
  const previousSkaterStats2 = await readJson<SkaterStatsFile>(`public/data/skater-stats-${PREV2}.json`);

  const previous = await readJson<InsightsInputsFile>(OUT);
  if (changed) {
    state.meta.updatedAt = nowIso;
    await saveState(state, season, written);
  }
  // Rebuild when the feature model changed, even with no new games.
  if (!changed && previous && previous.season === SEASON && previous.generatedAt >= state.meta.updatedAt && previous.settings?.featuresRevision === FEATURES_REVISION) {
    log(`Insights: nothing new; ${requests} requests`);
    return;
  }
  const next = buildInsightsInputs({ state, season, players, skaterStats, previousSeason, previousSkaterStats: previousSkaterStats?.season === PREV ? previousSkaterStats : undefined, previousSeason2, previousSkaterStats2: previousSkaterStats2?.season === PREV2 ? previousSkaterStats2 : undefined, target: plan.target, cfg: CFG, nowIso });
  const problems = insightsUpdateProblems(next, previous, players, skaterStats, !!season);
  if (problems.length) {
    warn(`insights-inputs.json NOT updated; kept the previous file: ${problems.join('; ')}`);
  } else {
    await writeFile(OUT, JSON.stringify(next));
    log(`Insights: wrote ${OUT}: ${Object.keys(next.players).length} skaters, ${Object.keys(next.goalies).length} goalies, ${Object.keys(next.teams).length} teams; nights ${next.windowNights}/${next.windowTarget}${next.complete ? ' (complete)' : ' (incomplete: trends not usable yet)'}; games through ${next.gamesThrough ?? '-'}`);
  }
  log(`Insights: done; ${requests} requests`);
}

main().catch((err) => {
  warn(`Insights refresh failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
