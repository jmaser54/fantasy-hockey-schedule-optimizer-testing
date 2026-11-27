/**
 * Derived Insights features computed from the private game window (never published as game lines):
 * blended Talent rates, expected minutes for Next Week and the playoffs, the three-state power-play
 * status, appearance facts and goalie start facts. Settings: src/domain/insightsSettings.ts.
 */
import type { PosGroup } from '../../domain/insightsSettings.ts';
import { MINUTES_HALF_TRUST, PP_PERSISTENCE, PP_RULE, PRIOR_MIN_GAMES, RECENT_MINUTES_GAMES, TALENT_HALF_TRUST } from '../../domain/insightsSettings.ts';
import { ppStatus, type PpGame } from '../../domain/ppStatus.ts';
import type { ExpectedMinutes, SkaterFeatures, TalentRates } from '../format.ts';
import type { SkaterLine } from './gamelog.ts';

/** Season totals the rates are built from (seconds for ice time). */
export interface SeasonTotals {
  gp: number;
  /** All points (verified scoring report); situational splits below come from the summary report. */
  pts?: number | null;
  g: number | null;
  evG: number | null;
  ppG: number | null;
  shG: number | null;
  evPts: number | null;
  ppPts: number | null;
  shPts: number | null;
  sog: number | null;
  hit: number | null;
  blk: number | null;
  pim: number | null;
  pm: number | null;
  fow: number | null;
  toi: number | null;
  evToi: number | null;
  ppToi: number | null;
  shToi: number | null;
  ppSharePg: number | null;
}

export const RATE_KEYS = ['evPts', 'ppPts', 'shPts', 'evG', 'ppG', 'shG', 'sog', 'hit', 'blk', 'pim', 'pm', 'fow'] as const;
type RateKey = (typeof RATE_KEYS)[number];
/** Which minutes each rate is measured against (each situation only against its own minutes). */
const RATE_MINUTES: Record<RateKey, 'evToi' | 'ppToi' | 'shToi' | 'toi'> = {
  evPts: 'evToi', ppPts: 'ppToi', shPts: 'shToi', evG: 'evToi', ppG: 'ppToi', shG: 'shToi',
  sog: 'toi', hit: 'toi', blk: 'toi', pim: 'toi', pm: 'toi', fow: 'toi',
};
const HALF_TRUST_KEY: Record<RateKey, keyof typeof TALENT_HALF_TRUST> = {
  evPts: 'evPts', ppPts: 'ppPts', shPts: 'shPts', evG: 'goals', ppG: 'goals', shG: 'goals',
  sog: 'sog', hit: 'hit', blk: 'blk', pim: 'pim', pm: 'pm', fow: 'fow',
};

export const posGroup = (positions: readonly string[]): PosGroup => (positions.includes('D') && !positions.some((p) => p === 'C' || p === 'LW' || p === 'RW') ? 'D' : 'F');

const per60 = (count: number | null, secs: number | null): number | null => (typeof count !== 'number' || typeof secs !== 'number' || secs <= 0 ? null : (count * 3600) / secs);
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Position averages (Σ counts ÷ Σ minutes) over players with at least `minGp` games. */
export function positionRates(totals: Iterable<[SeasonTotals, PosGroup]>, minGp: number): Record<PosGroup, Partial<Record<RateKey, number>>> {
  const acc: Record<PosGroup, Record<string, [number, number]>> = { F: {}, D: {} };
  for (const [t, grp] of totals) {
    if (t.gp < minGp) continue;
    for (const k of RATE_KEYS) {
      const c = t[k];
      const m = t[RATE_MINUTES[k]];
      if (typeof c !== 'number' || typeof m !== 'number' || m <= 0) continue;
      const a = (acc[grp][k] ??= [0, 0]);
      a[0] += c;
      a[1] += m;
    }
  }
  const out: Record<PosGroup, Partial<Record<RateKey, number>>> = { F: {}, D: {} };
  for (const g of ['F', 'D'] as const) for (const [k, [c, m]] of Object.entries(acc[g])) if (m > 0) out[g][k as RateKey] = (c * 3600) / m;
  return out;
}

/**
 * Talent: weight on the current season = gp ÷ (gp + halfTrust); the baseline is his previous season
 * when he played at least PRIOR_MIN_GAMES, otherwise players at his position.
 */
export function talentRates(current: SeasonTotals | undefined, previous: SeasonTotals | undefined, posAvg: Partial<Record<RateKey, number>>, group: PosGroup): { rates: TalentRates; gp: number; prior: 'player' | 'position' } {
  const gp = current?.gp ?? 0;
  const usePrev = !!previous && previous.gp >= PRIOR_MIN_GAMES;
  const rates = {} as TalentRates;
  for (const k of RATE_KEYS) {
    const rc = current ? per60(current[k], current[RATE_MINUTES[k]]) : null;
    const rp = (usePrev ? per60(previous![k], previous![RATE_MINUTES[k]]) : null) ?? posAvg[k] ?? null;
    const K = TALENT_HALF_TRUST[HALF_TRUST_KEY[k]][group];
    const v = rc === null ? rp : rp === null ? rc : (gp * rc + K * rp) / (gp + K);
    rates[k] = v === null ? null : r4(v);
  }
  return { rates, gp, prior: usePrev ? 'player' : 'position' };
}

/** One appearance in the window (newest first in the caller's arrays). */
export interface WindowAppearance {
  date: string;
  line: SkaterLine;
  teamPpToi: number | null;
}

const meanOf = (a: readonly number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const blend = (sample: number | null, n: number, prior: number | null, H: number): number | null =>
  sample === null ? prior : prior === null ? sample : (n * sample + H * prior) / (n + H);

/**
 * Expected minutes. Next Week leans on the latest RECENT_MINUTES_GAMES games; the playoffs use the whole
 * window (a brief change counts only in proportion to its share of the window). PP share: a confirmed
 * forward promotion uses baseline + retained share × rise (10-game figure for Next Week, 30-game figure
 * for the playoffs); an observed (unconfirmed) rise counts at his baseline for the playoffs.
 */
export function expectedMinutes(apps: readonly WindowAppearance[], season: SeasonTotals | undefined, posMinutes: { toi: number; evToi: number; shToi: number; ppShare: number }, pp: ReturnType<typeof ppStatus>): { nextWeek: ExpectedMinutes; playoffs: ExpectedMinutes } {
  const priorPg = (secs: number | null | undefined, fallback: number) => (season && season.gp > 0 && secs !== null && secs !== undefined ? secs / season.gp / 60 : fallback);
  const prior = { toi: priorPg(season?.toi, posMinutes.toi), evToi: priorPg(season?.evToi, posMinutes.evToi), shToi: priorPg(season?.shToi, posMinutes.shToi) };
  const recent = apps.slice(0, RECENT_MINUTES_GAMES);
  const mins = (list: readonly WindowAppearance[], i: number) => meanOf(list.map((a) => a.line[i]).filter((v): v is number => typeof v === 'number').map((v) => v / 60));
  const share = (list: readonly WindowAppearance[]) => {
    const u = list.filter((a) => typeof a.line[15] === 'number' && a.teamPpToi !== null && a.teamPpToi >= PP_RULE.minTeamPpSeconds);
    const team = u.reduce((s, a) => s + a.teamPpToi!, 0);
    return { v: team > 0 ? Math.min(1, u.reduce((s, a) => s + (a.line[15] as number), 0) / team) : null, n: u.length };
  };
  const seasonShare = season?.ppSharePg ?? posMinutes.ppShare;
  const ctx = (list: readonly WindowAppearance[], ppShareOverride: number | null): ExpectedMinutes => {
    const s = share(list);
    const v = (i: number, H: number, p: number) => r1(blend(mins(list, i), list.length, p, H) ?? p);
    return {
      toi: v(13, MINUTES_HALF_TRUST.toi, prior.toi),
      evToi: v(14, MINUTES_HALF_TRUST.evToi, prior.evToi),
      shToi: v(16, MINUTES_HALF_TRUST.shToi, prior.shToi),
      ppShare: r4(ppShareOverride ?? blend(s.v, s.n, seasonShare, MINUTES_HALF_TRUST.ppShare) ?? seasonShare),
    };
  };
  const confirmed = pp.state === 'confirmed' && pp.baseline !== null && pp.rise !== null;
  const nextShare = confirmed ? Math.min(1, pp.baseline! + PP_PERSISTENCE.retainedNext10 * pp.rise!) : null;
  const playoffShare = confirmed ? Math.min(1, pp.baseline! + PP_PERSISTENCE.retainedNext30 * pp.rise!) : pp.state === 'observed' ? pp.baseline : null;
  return { nextWeek: ctx(recent, nextShare), playoffs: ctx(apps, playoffShare) };
}

const ptsPg = (t: SeasonTotals | undefined) => {
  if (!t || t.gp < 1) return null;
  const pts = typeof t.pts === 'number' ? t.pts : t.evPts !== null && t.ppPts !== null && t.shPts !== null ? t.evPts + t.ppPts + t.shPts : null;
  return pts === null ? null : Math.round((pts / t.gp) * 1000) / 1000;
};

/** Everything published for one skater, from his window appearances (newest first). */
export function skaterFeatures(input: {
  apps: readonly WindowAppearance[];
  group: PosGroup;
  current: SeasonTotals | undefined;
  previous: SeasonTotals | undefined;
  posAvg: Partial<Record<RateKey, number>>;
  posMinutes: { toi: number; evToi: number; shToi: number; ppShare: number };
  /** His current team's game dates in the window, newest first. */
  teamDates: readonly string[];
}): SkaterFeatures {
  const { apps, group } = input;
  const ppGames: PpGame[] = [...apps]
    .reverse()
    .filter((a) => typeof a.line[15] === 'number' && a.teamPpToi !== null)
    .map((a) => ({ ppToi: a.line[15] as number, teamPpToi: a.teamPpToi! }));
  const pp = ppStatus(ppGames, group);
  const t = talentRates(input.current, input.previous, input.posAvg, group);
  const ev = (list: readonly WindowAppearance[]) => {
    const v = list.map((a) => a.line[14]).filter((x): x is number => typeof x === 'number');
    return v.length ? r1(v.reduce((s, x) => s + x, 0) / v.length / 60) : null;
  };
  const last = apps[0]?.date ?? null;
  return {
    group,
    rates: t.rates,
    rateGames: t.gp,
    prior: t.prior,
    minutes: expectedMinutes(apps, input.current, input.posMinutes, pp),
    pp,
    evMinutes: { last5: ev(apps.slice(0, 5)), window: ev(apps), windowGames: apps.length },
    lastGame: last,
    teamGamesSinceLast: last === null ? null : input.teamDates.filter((d) => d > last).length,
    production: {
      gp: input.current?.gp ?? 0,
      ptsPg: ptsPg(input.current),
      prevGp: input.previous?.gp ?? 0,
      prevPtsPg: ptsPg(input.previous),
    },
  };
}

/** Verified goalie start facts from gamesStarted (never inferred from appearances). */
export function goalieStartFacts(starts: readonly string[], teamDates: readonly string[]): { teamGames: number; starts: number; last10TeamGames: number; startsLast10: number; consecutiveStarts: number } {
  const set = new Set(starts);
  const last10 = teamDates.slice(0, 10);
  let streak = 0;
  for (const d of teamDates) {
    if (!set.has(d)) break;
    streak++;
  }
  return { teamGames: teamDates.length, starts: teamDates.filter((d) => set.has(d)).length, last10TeamGames: last10.length, startsLast10: last10.filter((d) => set.has(d)).length, consecutiveStarts: streak };
}
