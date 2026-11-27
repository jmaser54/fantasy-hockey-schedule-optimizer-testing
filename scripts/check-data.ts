/** Validate the committed dataset (public/data) the same way the app does at load time. */
import { readFile } from 'node:fs/promises';
import { buildDataset } from '../src/data/load.ts';
import { HISTORICAL_SEASONS, skaterStatsPath } from '../src/data/format.ts';
import { validateOwnership, validateSkaterStats } from '../src/data/validate.ts';

const schedule = JSON.parse(await readFile('public/data/schedule.json', 'utf8'));
const players = JSON.parse(await readFile('public/data/players.json', 'utf8'));
const data = buildDataset(schedule, players);
console.log(`OK: ${data.schedule.games.length} games, ${data.teams.length} teams, ${data.players.length} players (fetched ${data.scheduleFetchedAt})`);
for (const w of data.warnings.slice(0, 10)) console.log(`warning: ${w}`);

// Player Evaluator stats: validated when present. The file is created by the
// first successful refresh after the stats step was added.
let statsRaw: string | undefined;
try {
  statsRaw = await readFile('public/data/skater-stats.json', 'utf8');
} catch {
  console.log('warning: public/data/skater-stats.json not present yet');
}
if (statsRaw !== undefined) {
  const stats = JSON.parse(statsRaw);
  const v = validateSkaterStats(stats, { season: data.season, teamIds: new Set(data.teams.map((t) => t.id)) });
  for (const w of v.warnings.slice(0, 10)) console.log(`warning: ${w}`);
  if (v.errors.length) {
    console.error(`Skater stats failed validation:\n${v.errors.slice(0, 20).join('\n')}`);
    process.exit(1);
  }
  console.log(`OK: ${stats.skaters.length} skaters with stats (fetched ${stats.fetchedAt})`);
}

// Completed seasons' static snapshots: validated (incl. completeness) when present.
for (const { season, teamGames } of HISTORICAL_SEASONS) {
  let raw: string;
  try {
    raw = await readFile(`public/${skaterStatsPath(season)}`, 'utf8');
  } catch {
    console.log(`warning: public/${skaterStatsPath(season)} not present yet`);
    continue;
  }
  const stats = JSON.parse(raw);
  const v = validateSkaterStats(stats, { season, teamIds: new Set(data.teams.map((t) => t.id)), completeSeasonGames: teamGames });
  for (const w of v.warnings.slice(0, 10)) console.log(`warning (${season}): ${w}`);
  if (v.errors.length) {
    console.error(`Skater stats ${season} failed validation:\n${v.errors.slice(0, 20).join('\n')}`);
    process.exit(1);
  }
  console.log(`OK: ${season}: ${stats.skaters.length} skaters with stats (fetched ${stats.fetchedAt})`);
}

// ESPN ownership (future Insights): validated when present. The file is created by the first
// successful refresh after the ownership step was added; age is reported, not enforced here.
let ownershipRaw: string | undefined;
try {
  ownershipRaw = await readFile('public/data/ownership.json', 'utf8');
} catch {
  console.log('warning: public/data/ownership.json not present yet');
}
if (ownershipRaw !== undefined) {
  const own = JSON.parse(ownershipRaw);
  const v = validateOwnership(own, { season: data.season, playerIds: new Set(data.players.map((p) => p.id)) });
  for (const w of v.warnings.slice(0, 10)) console.log(`warning (ownership): ${w}`);
  if (v.errors.length) {
    console.error(`Ownership failed validation:\n${v.errors.slice(0, 20).join('\n')}`);
    process.exit(1);
  }
  const hours = Math.round((Date.now() - Date.parse(own.fetchedAt)) / 3_600_000);
  console.log(`OK: ownership for ${Object.keys(own.players).length} NHL players (ESPN read ${own.fetchedAt}, ${hours} h ago)`);
}
