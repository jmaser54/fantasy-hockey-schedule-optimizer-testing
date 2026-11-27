/**
 * ESPN fantasy ownership for NHL players (public/data/ownership.json), built from the ESPN
 * players_wl response the refresh already fetches. Ownership is a ranking signal for Insights
 * only: it never decides eligibility (that is the current NHL roster) or claims availability.
 */
import { OWNERSHIP_VERSION, type OwnershipFile, type PlayersFile } from '../format.ts';
import { validateOwnership } from '../validate.ts';
import type { EspnPlayer } from './espn.ts';

type DirPlayer = PlayersFile['players'][number];

/**
 * Hand-checked NHL id → ESPN id links for current NHL players ESPN lists under another first name
 * (verified 2026-11-27). Used only when the directory has no ESPN id for the player, the ESPN record
 * is in the response, no other player already has that ESPN id, and ESPN's team is the player's team.
 */
export const ESPN_ID_OVERRIDES: ReadonlyMap<number, number> = new Map([
  [8480813, 4352804], // Joseph Veleno → Joe Veleno
  [8479372, 4063504], // Josh Mahura → Joshua Mahura
  [8478470, 3942714], // Samuel Montembeault → Sam Montembeault
  [8482737, 4874734], // Zachary Bolduc → Zack Bolduc
]);

export const OWNERSHIP_SOURCE = 'ESPN fantasy hockey players_wl, ownership.percentOwned';

/** Safeguards: a refresh that misses these keeps the previous ownership.json. */
export const OWNERSHIP_MIN_CURRENT_COVERAGE = 0.9; // share of current NHL roster players with ownership
export const OWNERSHIP_MAX_UNKNOWN_SHARE = 0.02; // share of ESPN records without a valid percentage
export const OWNERSHIP_MAX_DROP = 0.1; // fall in entries versus the previous same-season file

export interface OwnershipBuild {
  file: OwnershipFile;
  report: string[];
  warnings: string[];
  stats: { currentPlayers: number; currentWithOwnership: number; espnRecords: number; espnUnknown: number; overridesApplied: number };
}

const isCurrent = (p: DirPlayer) => p.nhlId !== undefined && !p.inactive;

export function buildOwnership(input: {
  players: readonly DirPlayer[];
  espn: readonly EspnPlayer[];
  season: string;
  fetchedAt: string;
  overrides?: ReadonlyMap<number, number>;
}): OwnershipBuild {
  const overrides = input.overrides ?? ESPN_ID_OVERRIDES;
  const report: string[] = [];
  const warnings: string[] = [];
  const espnById = new Map(input.espn.map((e) => [e.espnId, e]));

  // ESPN proTeamId → NHL team by majority over current players the directory already links (team check for overrides).
  const votes = new Map<number, Map<string, number>>();
  for (const p of input.players) {
    const e = isCurrent(p) && p.espnId !== undefined ? espnById.get(p.espnId) : undefined;
    if (!e || e.proTeamId === 0) continue;
    const m = votes.get(e.proTeamId) ?? new Map<string, number>();
    m.set(p.team, (m.get(p.team) ?? 0) + 1);
    votes.set(e.proTeamId, m);
  }
  const teamOf = (proTeamId: number): string | undefined => {
    const m = votes.get(proTeamId);
    if (!m) return undefined;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [team, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return total >= 3 && n / total >= 0.6 ? team : undefined;
  };

  const claimed = new Set(input.players.filter((p) => p.nhlId !== undefined && p.espnId !== undefined).map((p) => p.espnId!));
  const players: OwnershipFile['players'] = {};
  let overridesApplied = 0;
  let currentPlayers = 0;
  let currentWithOwnership = 0;
  for (const p of input.players) {
    if (p.nhlId === undefined) continue; // ESPN-only records are not NHL players
    let espnId = p.espnId;
    const linked = overrides.get(p.nhlId);
    if (espnId === undefined && linked !== undefined) {
      const e = espnById.get(linked);
      if (!e) warnings.push(`ESPN id link ${p.name} (NHL ${p.nhlId}) → ${linked}: no such ESPN record; ownership unknown.`);
      else if (claimed.has(linked)) warnings.push(`ESPN id link ${p.name} (NHL ${p.nhlId}) → ${linked}: that ESPN id already belongs to another player; ignored.`);
      else if (teamOf(e.proTeamId) !== p.team) warnings.push(`ESPN id link ${p.name} (NHL ${p.nhlId}) → ${linked}: ESPN team ${teamOf(e.proTeamId) ?? 'unknown'} ≠ ${p.team}; ignored.`);
      else {
        espnId = linked;
        claimed.add(linked);
        overridesApplied++;
      }
    }
    const pct = espnId !== undefined ? espnById.get(espnId)?.percentOwned : undefined;
    if (isCurrent(p)) currentPlayers++;
    if (espnId === undefined || pct === undefined) continue; // unknown ownership: no entry, never 0
    players[`nhl-${p.nhlId}`] = { espnId, pct };
    if (isCurrent(p)) currentWithOwnership++;
  }
  const espnUnknown = input.espn.filter((e) => e.percentOwned === undefined).length;
  report.push(
    `Ownership: ${Object.keys(players).length} NHL players; current roster ${currentWithOwnership}/${currentPlayers}; ESPN id links applied ${overridesApplied}; ESPN records without a valid percentage ${espnUnknown}/${input.espn.length}`,
  );
  return {
    file: { version: OWNERSHIP_VERSION, season: input.season, fetchedAt: input.fetchedAt, source: OWNERSHIP_SOURCE, players },
    report,
    warnings,
    stats: { currentPlayers, currentWithOwnership, espnRecords: input.espn.length, espnUnknown, overridesApplied },
  };
}

/** Reasons not to replace the previous ownership.json with this build (empty = safe to write). */
export function ownershipUpdateProblems(build: OwnershipBuild, previous: OwnershipFile | undefined, playerIds: ReadonlySet<string>): string[] {
  const { currentPlayers, currentWithOwnership, espnRecords, espnUnknown } = build.stats;
  const problems: string[] = [];
  if (currentPlayers === 0) problems.push('no current NHL roster players');
  else if (currentWithOwnership / currentPlayers < OWNERSHIP_MIN_CURRENT_COVERAGE)
    problems.push(`only ${currentWithOwnership}/${currentPlayers} current NHL players have ownership (need ${OWNERSHIP_MIN_CURRENT_COVERAGE * 100}%)`);
  if (espnRecords === 0 || espnUnknown / espnRecords > OWNERSHIP_MAX_UNKNOWN_SHARE)
    problems.push(`${espnUnknown}/${espnRecords} ESPN records have no valid ownership percentage (max ${OWNERSHIP_MAX_UNKNOWN_SHARE * 100}%)`);
  const now = Object.keys(build.file.players).length;
  if (previous && previous.season === build.file.season) {
    const before = Object.keys(previous.players).length;
    if (now < before * (1 - OWNERSHIP_MAX_DROP)) problems.push(`entries fell from ${before} to ${now} (max drop ${OWNERSHIP_MAX_DROP * 100}%)`);
  }
  const v = validateOwnership(build.file, { season: build.file.season, playerIds });
  problems.push(...v.errors);
  return problems;
}
