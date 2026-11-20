import type { SkaterPositionCode, SkaterStatLine } from '../data/format.ts';
import type { StatKey } from '../domain/evaluator.ts';
import { normalizeName } from '../domain/names.ts';

/** Player Evaluator display helpers (pure). Layout choices here are prototype defaults, easy to change. */

export const STAT_SHORT: Record<StatKey, string> = {
  gamesPlayed: 'GP',
  goals: 'G',
  assists: 'A',
  points: 'P',
  plusMinus: '+/-',
  penaltyMinutes: 'PIM',
  ppPoints: 'PPP',
  shPoints: 'SHP',
  shots: 'SOG',
  shootingPct: 'S%',
  hits: 'HIT',
  blockedShots: 'BLK',
  faceoffWins: 'FOW',
  faceoffWinPct: 'FO%',
  toiPerGame: 'TOI',
};

export type StatGroupId = 'scoring' | 'peripherals' | 'rates' | 'all';
export const STAT_GROUPS: { id: StatGroupId; label: string; stats: StatKey[] }[] = [
  { id: 'scoring', label: 'Scoring', stats: ['goals', 'assists', 'points', 'ppPoints', 'shPoints'] },
  { id: 'peripherals', label: 'Peripherals', stats: ['shots', 'hits', 'blockedShots', 'penaltyMinutes', 'faceoffWins'] },
  { id: 'rates', label: 'Rates', stats: ['plusMinus', 'shootingPct', 'faceoffWinPct', 'toiPerGame'] },
];
STAT_GROUPS.push({ id: 'all', label: 'All', stats: STAT_GROUPS.flatMap((g) => g.stats) });

/** NHL position code as shown to fantasy managers. */
export const POSITION_SHORT: Record<SkaterPositionCode, string> = { C: 'C', L: 'LW', R: 'RW', D: 'D' };

/** Normalized counting stats keep one decimal (the full value is in the cell's title). */
export const formatAdjusted = (v: number): string => v.toFixed(1);

/** A reported value: counts as integers, +/- signed, percentages to one decimal, TOI as m:ss. */
export function formatStat(key: StatKey, v: number | null): string {
  if (v === null) return '—';
  if (key === 'shootingPct' || key === 'faceoffWinPct') return `${(v * 100).toFixed(1)}%`;
  if (key === 'toiPerGame') {
    const s = Math.round(v);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  if (key === 'plusMinus') return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
  return String(v);
}

/** Skaters in the stats snapshot whose name contains every word of the query. */
export function searchSkaters(query: string, skaters: readonly SkaterStatLine[], exclude: ReadonlySet<number>, limit = 8): SkaterStatLine[] {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (words.length === 0 || words.join('').length < 2) return [];
  const out: SkaterStatLine[] = [];
  for (const s of skaters) {
    if (exclude.has(s.nhlId)) continue;
    const name = normalizeName(s.name);
    if (words.every((w) => name.split(' ').some((part) => part.startsWith(w)))) out.push(s);
  }
  return out.sort((a, b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name)).slice(0, limit);
}
