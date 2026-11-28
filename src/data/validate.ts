/**
 * Structural and consistency checks for the bundled dataset. Used by the
 * refresh script (a failing check aborts the write) and by the app at load
 * time (a failing check is surfaced as a data-status error, never ignored).
 */
import { PP_RULE } from '../domain/insightsSettings.ts';
import { isValidISODate } from '../domain/dates.ts';
import { POSITIONS } from '../domain/types.ts';
import { DATA_VERSION, INSIGHTS_VERSION, OWNERSHIP_VERSION, type PlayersFile, type ScheduleFile, type SkaterStatsFile } from './format.ts';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateSchedule(data: unknown, opts: { expectedGamesPerTeam?: number } = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(data)) return { errors: ['Schedule file is not an object.'], warnings };
  if (data.version !== DATA_VERSION) errors.push(`Unsupported schedule version ${String(data.version)}.`);
  if (!Array.isArray(data.teams) || !Array.isArray(data.games)) {
    errors.push('Schedule file is missing teams or games.');
    return { errors, warnings };
  }
  const file = data as unknown as ScheduleFile;
  const teamIds = new Set<string>();
  for (const t of file.teams) {
    if (!isObj(t) || typeof t.id !== 'string' || typeof t.name !== 'string') {
      errors.push('Malformed team record.');
      continue;
    }
    if (teamIds.has(t.id)) errors.push(`Duplicate team ${t.id}.`);
    teamIds.add(t.id);
  }
  const ids = new Set<string>();
  const teamDate = new Set<string>();
  const perTeam = new Map<string, number>([...teamIds].map((t) => [t, 0]));
  for (const g of file.games) {
    if (!isObj(g) || typeof g.id !== 'string' || !isValidISODate(g.date) || typeof g.home !== 'string' || typeof g.away !== 'string') {
      errors.push(`Malformed game record ${isObj(g) ? String(g.id) : ''}.`);
      continue;
    }
    if (ids.has(g.id)) errors.push(`Duplicate game ${g.id}.`);
    ids.add(g.id);
    if (g.home === g.away) errors.push(`Game ${g.id} has the same home and away team.`);
    for (const t of [g.home, g.away]) {
      if (!teamIds.has(t)) errors.push(`Game ${g.id} references unknown team ${t}.`);
      const key = `${t}|${g.date}`;
      if (teamDate.has(key)) errors.push(`${t} has two games on ${g.date}.`);
      teamDate.add(key);
      perTeam.set(t, (perTeam.get(t) ?? 0) + 1);
    }
  }
  if (opts.expectedGamesPerTeam) {
    for (const [t, n] of perTeam) {
      if (n !== opts.expectedGamesPerTeam) errors.push(`${t} has ${n} games; expected ${opts.expectedGamesPerTeam}.`);
    }
  } else {
    const counts = new Set(perTeam.values());
    if (counts.size > 1) warnings.push(`Teams have unequal game counts (${[...counts].sort().join(', ')}).`);
  }
  if (file.games.length === 0) errors.push('Schedule has no games.');
  return { errors, warnings };
}

export function validatePlayers(data: unknown, teamIds: ReadonlySet<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(data)) return { errors: ['Players file is not an object.'], warnings };
  if (data.version !== DATA_VERSION) errors.push(`Unsupported players version ${String(data.version)}.`);
  if (!Array.isArray(data.players)) return { errors: [...errors, 'Players file has no players.'], warnings };
  const file = data as unknown as PlayersFile;
  const ids = new Set<string>();
  const nhlIds = new Set<number>();
  const espnIds = new Set<number>();
  for (const p of file.players) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.team !== 'string' || !Array.isArray(p.positions)) {
      errors.push('Malformed player record.');
      continue;
    }
    if (ids.has(p.id)) errors.push(`Duplicate player ${p.id}.`);
    ids.add(p.id);
    if (p.nhlId !== undefined) {
      if (nhlIds.has(p.nhlId)) errors.push(`NHL id ${p.nhlId} appears twice.`);
      nhlIds.add(p.nhlId);
    }
    if (p.espnId !== undefined) {
      if (espnIds.has(p.espnId)) errors.push(`ESPN id ${p.espnId} appears twice.`);
      espnIds.add(p.espnId);
    }
    if (!teamIds.has(p.team)) errors.push(`${p.name} is on unknown team ${p.team}.`);
    if (p.positions.length === 0) warnings.push(`${p.name} has no eligible positions.`);
    if (p.positions.some((x) => !POSITIONS.includes(x))) errors.push(`${p.name} has an unknown position.`);
    for (const s of p.stints ?? []) {
      if (!teamIds.has(s.team)) errors.push(`${p.name} has a stint on unknown team ${s.team}.`);
      if ((s.from && !isValidISODate(s.from)) || (s.to && !isValidISODate(s.to))) errors.push(`${p.name} has a malformed stint.`);
    }
  }
  if (file.players.length < 500) warnings.push(`Only ${file.players.length} players in the directory.`);
  return { errors, warnings };
}

const COUNTING_STATS = ['gamesPlayed', 'goals', 'assists', 'points', 'penaltyMinutes', 'ppPoints', 'shPoints', 'shots', 'hits', 'blockedShots', 'faceoffWins'] as const;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFraction = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/**
 * Player Evaluator skater statistics (public/data/skater-stats.json).
 * `teamIds` checks team codes; `previous` (same season) guards against a
 * snapshot that suddenly lost players, since a skater who has played never
 * drops out of the season's list.
 */
export function validateSkaterStats(
  data: unknown,
  opts: {
    season?: string;
    teamIds?: ReadonlySet<string>;
    previous?: SkaterStatsFile;
    /** Completed seasons only: games per team. The season must be finished (some skater played every game). */
    completeSeasonGames?: number;
  } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(data)) return { errors: ['Skater stats file is not an object.'], warnings };
  if (data.version !== DATA_VERSION) errors.push(`Unsupported skater stats version ${String(data.version)}.`);
  if (typeof data.season !== 'string' || !/^\d{8}$/.test(data.season)) errors.push('Skater stats file has no season.');
  else if (opts.season && data.season !== opts.season) errors.push(`Skater stats are for season ${data.season}; expected ${opts.season}.`);
  if (data.gameType !== 2) errors.push(`Skater stats are for game type ${String(data.gameType)}; expected 2 (regular season).`);
  if (typeof data.fetchedAt !== 'string' || Number.isNaN(Date.parse(data.fetchedAt))) errors.push('Skater stats file has no valid fetchedAt.');
  if (!Array.isArray(data.skaters)) return { errors: [...errors, 'Skater stats file has no skaters.'], warnings };
  const file = data as unknown as SkaterStatsFile;
  const ids = new Set<number>();
  for (const s of file.skaters) {
    if (!isObj(s) || !isInt(s.nhlId) || typeof s.name !== 'string' || !s.name || !Array.isArray(s.teams) || s.teams.length === 0) {
      errors.push('Malformed skater stats record.');
      continue;
    }
    const who = `${s.name} (${s.nhlId})`;
    if (ids.has(s.nhlId)) errors.push(`Skater ${s.nhlId} appears twice.`);
    ids.add(s.nhlId);
    if (!['C', 'L', 'R', 'D'].includes(s.position as string)) errors.push(`${who} has unknown position ${String(s.position)}.`);
    for (const t of s.teams) if (typeof t !== 'string' || (opts.teamIds && !opts.teamIds.has(t))) errors.push(`${who} has unknown team ${String(t)}.`);
    const bad = COUNTING_STATS.filter((k) => !isInt(s[k]) || (s[k] as number) < 0);
    if (bad.length) {
      errors.push(`${who} has invalid ${bad.join(', ')}.`);
      continue;
    }
    if (!isInt(s.plusMinus)) errors.push(`${who} has invalid plusMinus.`);
    if (s.gamesPlayed < 1) errors.push(`${who} has ${s.gamesPlayed} games played.`);
    if (s.goals + s.assists !== s.points) errors.push(`${who}: goals + assists ≠ points.`);
    if (s.ppPoints + s.shPoints > s.points) errors.push(`${who}: PP + SH points exceed points.`);
    if (s.shots === 0 ? s.shootingPct !== null : !isFraction(s.shootingPct) || Math.abs(s.shootingPct - s.goals / s.shots) > 1e-3) {
      errors.push(`${who} has inconsistent shooting percentage.`);
    }
    if (s.faceoffWinPct !== null && !isFraction(s.faceoffWinPct)) errors.push(`${who} has invalid faceoff percentage.`);
    if (s.faceoffWins > 0 && !s.faceoffWinPct) errors.push(`${who} has faceoff wins but no faceoff percentage.`);
    if (typeof s.toiPerGame !== 'number' || !(s.toiPerGame > 0) || s.toiPerGame > 3600) errors.push(`${who} has invalid time on ice.`);
  }
  if (file.skaters.length === 0) errors.push('Skater stats file has no skaters.');
  if (opts.completeSeasonGames && file.skaters.length > 0) {
    const maxGp = Math.max(...file.skaters.map((s) => (isObj(s) && isInt(s.gamesPlayed) ? s.gamesPlayed : 0)));
    if (maxGp < opts.completeSeasonGames) errors.push(`Season looks incomplete: the most games played is ${maxGp}; expected at least ${opts.completeSeasonGames}.`);
  }
  const prev = opts.previous;
  if (prev && prev.season === file.season && Array.isArray(prev.skaters)) {
    if (file.skaters.length < prev.skaters.length * 0.9) {
      errors.push(`Only ${file.skaters.length} skaters; the previous snapshot had ${prev.skaters.length}.`);
    } else if (file.skaters.length < prev.skaters.length) {
      warnings.push(`${prev.skaters.length - file.skaters.length} fewer skaters than the previous snapshot.`);
    }
  }
  return { errors, warnings };
}

/**
 * ownership.json: structure, season and 0–100 percentages. A player id not in the directory is a
 * warning (the files can be a refresh apart); anything else wrong is an error.
 */
export function validateOwnership(data: unknown, opts: { season?: string; playerIds?: ReadonlySet<string> } = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(data)) return { errors: ['Ownership file is not an object.'], warnings };
  if (data.version !== OWNERSHIP_VERSION) errors.push(`Unsupported ownership version ${String(data.version)}.`);
  if (typeof data.season !== 'string' || !/^\d{8}$/.test(data.season)) errors.push('Ownership file has no season.');
  else if (opts.season && data.season !== opts.season) errors.push(`Ownership is for season ${data.season}; expected ${opts.season}.`);
  if (typeof data.fetchedAt !== 'string' || Number.isNaN(Date.parse(data.fetchedAt))) errors.push('Ownership file has no valid fetchedAt.');
  if (typeof data.source !== 'string' || !data.source) errors.push('Ownership file has no source.');
  if (!isObj(data.players)) return { errors: [...errors, 'Ownership file has no players.'], warnings };
  const espnIds = new Set<number>();
  let unknownIds = 0;
  for (const [id, entry] of Object.entries(data.players)) {
    if (!/^nhl-\d+$/.test(id)) {
      errors.push(`Ownership key ${id} is not an NHL player id.`);
      continue;
    }
    if (!isObj(entry)) {
      errors.push(`Ownership entry ${id} is not an object.`);
      continue;
    }
    const { espnId, pct } = entry;
    if (typeof espnId !== 'number' || !Number.isInteger(espnId) || espnId <= 0) errors.push(`Ownership entry ${id} has an invalid ESPN id.`);
    else if (espnIds.has(espnId)) errors.push(`ESPN id ${espnId} appears twice in ownership.`);
    else espnIds.add(espnId);
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) errors.push(`Ownership entry ${id} has an invalid percentage ${String(pct)}.`);
    if (opts.playerIds && !opts.playerIds.has(id)) unknownIds++;
  }
  if (unknownIds) warnings.push(`${unknownIds} ownership entries are not in the player directory.`);
  return { errors, warnings };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * insights-inputs.json: structure, keys, windows and value ranges. Missing evidence is null or an absent
 * key, never 0; a player id not in the directory is a warning (the files can be a refresh apart).
 */
export function validateInsightsInputs(data: unknown, opts: { season?: string; playerIds?: ReadonlySet<string> } = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(data)) return { errors: ['Insights inputs file is not an object.'], warnings };
  if (data.version !== INSIGHTS_VERSION) errors.push(`Unsupported insights inputs version ${String(data.version)}.`);
  if (typeof data.season !== 'string' || !/^\d{8}$/.test(data.season)) errors.push('Insights inputs have no season.');
  else if (opts.season && data.season !== opts.season) errors.push(`Insights inputs are for season ${data.season}; expected ${opts.season}.`);
  if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) errors.push('Insights inputs have no valid generatedAt.');
  for (const k of ['gamesThrough', 'settledThrough'] as const) if (data[k] !== null && !(typeof data[k] === 'string' && ISO_DAY.test(data[k] as string))) errors.push(`Insights inputs ${k} is not a date or null.`);
  if (!Number.isInteger(data.windowNights) || !Number.isInteger(data.windowTarget) || (data.windowNights as number) < 0 || (data.windowNights as number) > (data.windowTarget as number)) errors.push('Insights inputs window counts are invalid.');
  if (typeof data.complete !== 'boolean') errors.push('Insights inputs have no complete flag.');
  if (!isObj(data.settings) || !isObj(data.sources)) errors.push('Insights inputs have no settings or sources.');
  if (!isObj(data.players) || !isObj(data.teams) || !isObj(data.goalies)) return { errors: [...errors, 'Insights inputs have no players, teams or goalies.'], warnings };
  const nonNeg = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const intOrNull = (v: unknown, allowNeg = false) => v === null || (typeof v === 'number' && Number.isInteger(v) && (allowNeg || v >= 0));
  const checkWindow = (id: string, name: string, w: unknown, maxGp: number) => {
    if (!isObj(w) || !isObj(w.talent) || !isObj(w.opportunity)) return errors.push(`${id} ${name}: missing talent/opportunity.`);
    if (!Number.isInteger(w.gp) || (w.gp as number) < 1 || (w.gp as number) > maxGp) errors.push(`${id} ${name}: games ${String(w.gp)}.`);
    if (typeof w.from !== 'string' || typeof w.to !== 'string' || !ISO_DAY.test(w.from) || !ISO_DAY.test(w.to) || w.from > w.to) errors.push(`${id} ${name}: dates.`);
    for (const [k, v] of Object.entries(w.talent)) if (!intOrNull(v, k === 'pm')) errors.push(`${id} ${name}: talent.${k} ${String(v)}.`);
    for (const k of ['toi', 'evToi', 'ppToi', 'shToi', 'teamPpToi']) if (!nonNeg(w.opportunity[k])) errors.push(`${id} ${name}: opportunity.${k}.`);
    const share = w.opportunity.ppShare;
    if (share !== null && !(typeof share === 'number' && share >= 0 && share <= 1)) errors.push(`${id} ${name}: ppShare ${String(share)}.`);
    return 0;
  };
  const PP_STATES = ['insufficient', 'none', 'observed', 'confirmed'];
  const checkFeatures = (id: string, f: unknown) => {
    if (!isObj(f) || (f.group !== 'F' && f.group !== 'D') || !isObj(f.rates) || !isObj(f.minutes) || !isObj(f.pp)) return errors.push(`${id} features are malformed.`);
    for (const [k, v] of Object.entries(f.rates)) if (!(v === null || (typeof v === 'number' && Number.isFinite(v) && (k === 'pm' || v >= 0)))) errors.push(`${id} features.rates.${k} ${String(v)}.`);
    for (const c of ['nextWeek', 'playoffs']) {
      const m = f.minutes[c];
      if (!isObj(m) || !['toi', 'evToi', 'shToi'].every((k) => typeof m[k] === 'number' && (m[k] as number) >= 0 && (m[k] as number) < 70) || !(typeof m.ppShare === 'number' && m.ppShare >= 0 && m.ppShare <= 1)) errors.push(`${id} features.minutes.${c} is invalid.`);
    }
    if (!PP_STATES.includes(f.pp.state as string)) errors.push(`${id} features.pp.state ${String(f.pp.state)}.`);
    if (f.participation !== undefined) {
      const q = f.participation;
      const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
      if (!isObj(q) || !unit(q.nextWeek) || !Number.isInteger(q.teamGames) || !Number.isInteger(q.streak) || (q.streak as number) > (q.teamGames as number) || !Number.isInteger(q.played) || (q.played as number) > (q.teamGames as number)) errors.push(`${id} features.participation is invalid.`);
    }
    // Rules that must hold in the data itself: only forwards are confirmed, and only with enough history.
    if (f.pp.state === 'confirmed' && f.group !== 'F') errors.push(`${id}: a defenceman has a confirmed PP promotion.`);
    if (f.pp.state !== 'insufficient' && !((f.pp.usableGames as number) >= PP_RULE.minUsableGames)) errors.push(`${id}: PP status without enough usable games.`);
    return 0;
  };
  let unknown = 0;
  for (const [id, p] of Object.entries(data.players)) {
    if (!/^nhl-\d+$/.test(id) || !isObj(p) || typeof p.team !== 'string' || !/^[A-Z]{3}$/.test(p.team)) { errors.push(`Insights player ${id} is malformed.`); continue; }
    if (opts.playerIds && !opts.playerIds.has(id)) unknown++;
    if (p.last5 !== undefined) checkWindow(id, 'last5', p.last5, 5);
    if (p.last10 !== undefined) checkWindow(id, 'last10', p.last10, 10);
    if (isObj(p.last5) && isObj(p.last10) && (p.last5.gp as number) > (p.last10.gp as number)) errors.push(`${id}: last5 has more games than last10.`);
    if (p.window !== undefined) checkWindow(id, 'window', p.window, 120);
    if (p.features !== undefined) checkFeatures(id, p.features);
    if (p.season !== undefined && (!isObj(p.season) || !Number.isInteger(p.season.gp) || (p.season.gp as number) < 1 || !isObj(p.season.talent) || !isObj(p.season.opportunity))) errors.push(`${id} season block is malformed.`);
  }
  for (const [id, g] of Object.entries(data.goalies)) {
    if (!/^nhl-\d+$/.test(id) || !isObj(g) || typeof g.team !== 'string') { errors.push(`Insights goalie ${id} is malformed.`); continue; }
    if (opts.playerIds && !opts.playerIds.has(id)) unknown++;
    for (const w of [g.last5, g.season]) {
      if (w === undefined) continue;
      if (!isObj(w) || (w.sv as number) > (w.sa as number) || !(w.svPct === null || (typeof w.svPct === 'number' && w.svPct >= 0 && w.svPct <= 1))) errors.push(`${id} goalie window is invalid.`);
    }
  }
  for (const id of Object.keys(data.teams)) if (!/^[A-Z]{3}$/.test(id)) errors.push(`Insights team key ${id} is invalid.`);
  if (unknown) warnings.push(`${unknown} insights entries are not in the player directory.`);
  return { errors, warnings };
}
