/**
 * Insight rules, ranking and wording (§J). Deterministic and rules-based. Every user-facing line is
 * tagged as a verified fact or an expectation; goalie output is facts only.
 *
 * Custom Insights (setup complete): the best add/drop moves for the user's roster in Next Week or the
 * playoffs (Playoff Edge), roster warnings above the cards, and a compact Goalie Schedule below them.
 * General Insights (no setup): league-wide observations from the same player intelligence.
 */
import type { InsightsInputsFile, SkaterFeatures } from '../data/format.ts';
import { isOnCurrentNhlRoster, type DirectoryPlayer, type OwnershipData } from '../data/load.ts';
import { formatShort, weekday } from './dates.ts';
import { CUSTOM_MAX, PARTICIPATION, PP_PERSISTENCE, TALENT_HALF_TRUST, TYPICAL_ERROR_PER_GAME } from './insightsSettings.ts';
import { rosterValue, searchMoves, skaterSeats, type DayLineup, type RosterValue, type ValuedPlayer } from './insightsSearch.ts';
import { buildScale, errorPerGame, ownershipWeight, perGame, teamPpSeconds, valuePerGame, type CategoryScale, type InsightContext } from './insightsValue.ts';
import { expandSeats } from './optimizer.ts';
import { effectivePositions } from './roster.ts';
import { playerGameOn, type ScheduleIndex } from './schedule.ts';
import { SKATER_CATEGORIES, type ScoringSettings, type SkaterCategory } from './scoring.ts';
import type { ISODate, LeagueConfig, Player, RosterEntry } from './types.ts';

export interface InsightLine {
  kind: 'talent' | 'opportunity' | 'fit' | 'ownership' | 'context';
  /** fact: verified from the data; expectation: an estimate or projection. */
  basis: 'fact' | 'expectation';
  text: string;
}

export interface CustomCard {
  addId: string;
  addName: string;
  addTeam: string;
  dropId?: string;
  dropName?: string;
  /**
   * IR alternative (2026-11-28): instead of dropping this player, keep him on IR (only if he qualifies under
   * the league's rules; never inferred from missed games). `laterDropName` is who you'd then clear when he
   * returns, judged over the playoff rounds. When set, dropId is undefined.
   */
  irId?: string;
  irName?: string;
  laterDropName?: string;
  headline: string;
  lines: InsightLine[];
  /** Ranking score (cautious gain × ownership weight) and the raw gain, in value units. */
  score: number;
  gain: number;
}

export interface CustomResult {
  cards: CustomCard[];
  warnings: string[];
  goalieSchedule: InsightLine[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mmss = (min: number) => `${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, '0')}`.replace(/:60$/, ':59');
const day = (d: ISODate) => weekday(d);
const dateList = (ds: readonly ISODate[], max = 4) => (ds.length <= max ? ds.map(day).join(', ') : `${ds.length} dates (${ds.slice(0, 3).map(formatShort).join(', ')}, …)`);
const CAT_UNITS: Record<SkaterCategory, string> = { g: 'goals', a: 'assists', pts: 'points', ppp: 'PP points', shp: 'SH points', sog: 'shots', hit: 'hits', blk: 'blocks', pim: 'PIM', pm: 'plus/minus', fow: 'faceoff wins' };
const nhlKey = (p: Pick<Player, 'nhlId'>) => (p.nhlId === undefined ? undefined : `nhl-${p.nhlId}`);

/** Every id form a rostered player can appear under (saved id, directory id, nhl-, espn-). */
export function rosterIdForms(roster: readonly RosterEntry[], resolve: (id: string) => Player | undefined): Set<string> {
  const out = new Set<string>();
  for (const e of roster) {
    out.add(e.playerId);
    const p = resolve(e.playerId);
    if (!p) continue;
    out.add(p.id);
    if (p.nhlId !== undefined) out.add(`nhl-${p.nhlId}`);
    if (p.espnId !== undefined) out.add(`espn-${p.espnId}`);
  }
  return out;
}

const isSkater = (positions: readonly string[]) => positions.some((p) => p !== 'G');

/** The scale is built once per data file from Next Week amounts of regular skaters, so both contexts share it. */
export function categoryScale(insights: InsightsInputsFile, cats: readonly SkaterCategory[]): CategoryScale {
  const pool = Object.values(insights.players)
    .filter((p) => p.features && p.features.rateGames >= 10)
    .map((p) => perGame(p.features!, teamPpSeconds(insights, p.team), 'nextWeek'));
  return buildScale(pool, cats);
}

function talentLine(pg: Record<SkaterCategory, number | null>, scale: CategoryScale): InsightLine | undefined {
  // Plus/minus is mostly luck (measured), so it never headlines the Talent line, though it still counts in value.
  const parts = scale.cats
    .filter((c) => c !== 'pm')
    .map((c) => ({ c, v: pg[c] ?? 0, z: Math.max(0, pg[c] ?? 0) / scale.sd[c]! }))
    .sort((a, b) => b.z - a.z)
    .slice(0, 2)
    .map(({ c, v }) => `${v.toFixed(c === 'g' || c === 'a' || c === 'pts' || c === 'ppp' || c === 'shp' ? 2 : 1)} ${CAT_UNITS[c]}`);
  return parts.length ? { kind: 'talent', basis: 'expectation', text: `Expected per game: ${parts.join(' · ')}` } : undefined;
}

/** Opportunity evidence: a confirmed forward PP role as a fact plus how it is valued; otherwise supporting facts only. */
export function opportunityLines(f: SkaterFeatures, ctx: InsightContext): InsightLine[] {
  const out: InsightLine[] = [];
  const pp = f.pp;
  if (pp.state === 'confirmed' && f.group === 'F' && pp.baseline !== null && pp.recent !== null) {
    out.push({ kind: 'opportunity', basis: 'fact', text: `Power-play share up from ${pct(pp.baseline)} to ${pct(pp.recent)} in ${pp.elevated} of his last 8 games` });
    const kept = ctx === 'nextWeek' ? PP_PERSISTENCE.retainedNext10 : PP_PERSISTENCE.retainedNext30;
    const held = ctx === 'nextWeek' ? PP_PERSISTENCE.continuedNext10 : PP_PERSISTENCE.continuedNext30;
    out.push({
      kind: 'context',
      basis: 'expectation',
      text: `Valued as if he keeps about ${pct(kept)} of that rise, the typical share kept in past seasons (provisional). About ${Math.round(held * 10)} in 10 such rises largely held; the cause isn't known.`,
    });
  } else if (pp.state === 'observed' && pp.baseline !== null && pp.recent !== null) {
    out.push({ kind: 'opportunity', basis: 'fact', text: `Power-play share ${pct(pp.recent)} over his last 8 games, ${pct(pp.baseline)} before` });
  }
  const ev = f.evMinutes;
  if (ev.last5 !== null && ev.window !== null && ev.windowGames >= 10 && ev.last5 - ev.window >= 1.5) {
    out.push({ kind: 'opportunity', basis: 'fact', text: `Even-strength ice time ${mmss(ev.last5)} a game over his last 5, ${mmss(ev.window)} across his last ${ev.windowGames}` });
  }
  if (!out.length) {
    const m = f.minutes[ctx];
    out.push({ kind: 'opportunity', basis: 'expectation', text: `Expected ice time ${mmss(m.toi)} a game, ${pct(m.ppShare)} of his team's power-play time` });
  }
  return out;
}

/**
 * Next Week value multiplier (simplified 2026-11-28): 1 unless he is currently in a prolonged absence
 * (PARTICIPATION.longAbsenceGames+ team games missed in a row), then the measured share from the data file.
 * The streak check also neutralises older files whose shares discounted shorter misses.
 */
export function nextWeekAvailability(f: SkaterFeatures): number {
  const q = f.participation;
  return q && q.streak >= PARTICIPATION.longAbsenceGames ? q.nextWeek : 1;
}

/**
 * Factual availability context for a card's player (never a prediction or a talent measure): his current run
 * of missed team games (reason unknown), and his dressing record (every missed game counted) when it is notably
 * low even leaving that run aside, so the two lines never say the same thing.
 */
export function availabilityLines(name: string, f: SkaterFeatures): InsightLine[] {
  const q = f.participation;
  if (!q) return [];
  const out: InsightLine[] = [];
  if (q.streak > 0) out.push({ kind: 'context', basis: 'fact', text: `${name} hasn't played in his team's last ${q.streak} game${q.streak === 1 ? '' : 's'} (reason unknown). Check his status before acting.` });
  if (q.teamGames > q.streak && q.played / (q.teamGames - q.streak) < PARTICIPATION.dressedNoteBelow) out.push({ kind: 'context', basis: 'fact', text: `${name} dressed for ${q.played} of his team's last ${q.teamGames} games` });
  return out;
}

export interface CustomInput {
  ctx: InsightContext;
  dates: readonly ISODate[];
  /** Playoff Edge: the configured rounds, for per-round usable games. */
  rounds?: readonly { name: string; dates: readonly ISODate[] }[];
  /** The configured playoff dates: future value for the IR alternative (defaults to `dates` in Playoff Edge). */
  futureDates?: readonly ISODate[];
  roster: readonly RosterEntry[];
  resolve: (id: string) => Player | undefined;
  directory: readonly DirectoryPlayer[];
  league: LeagueConfig;
  scoring: ScoringSettings;
  insights: InsightsInputsFile;
  /** Fresh ownership only (ownershipForRanking); undefined = neutral for everyone. */
  ownership: OwnershipData | undefined;
  schedule: ScheduleIndex;
  teamName: (abbrev: string) => string;
}

export function customInsights(input: CustomInput): CustomResult {
  const { ctx, dates, insights, schedule } = input;
  const scale = categoryScale(insights, input.scoring.skater);
  const exclude = rosterIdForms(input.roster, input.resolve);
  const valueOf = (key: string | undefined): { value: number; f: SkaterFeatures; pg: Record<SkaterCategory, number | null> } | undefined => {
    const e = key ? insights.players[key] : undefined;
    if (!e?.features) return undefined;
    const pg = perGame(e.features, teamPpSeconds(insights, e.team), ctx);
    const perGameValue = valuePerGame(pg, scale);
    // Participation is a supporting availability consideration only (simplified 2026-11-28): Next Week
    // value is discounted solely for a player currently in a prolonged absence; playoff value never is.
    const dress = ctx === 'nextWeek' ? nextWeekAvailability(e.features) : 1;
    return perGameValue === null ? undefined : { value: perGameValue * dress, f: e.features, pg };
  };

  // The user's active skaters. Players without data keep a modest value (the pool's lower quartile) so
  // their seats aren't treated as empty, and are never offered as drops.
  const poolValues = Object.values(insights.players)
    .filter((p) => p.features && p.features.rateGames >= 10)
    .map((p) => valuePerGame(perGame(p.features!, teamPpSeconds(insights, p.team), ctx), scale))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const fallback = poolValues[Math.floor(poolValues.length * 0.25)] ?? 0;
  const roster: ValuedPlayer[] = [];
  const droppable = new Set<string>();
  const names = new Map<string, string>();
  const info = new Map<string, ReturnType<typeof valueOf>>();
  for (const e of input.roster) {
    const p = input.resolve(e.playerId);
    if (!p || e.onIr) continue;
    const positions = effectivePositions(e, p).filter((x) => x !== 'G');
    if (!positions.length) continue;
    const v = valueOf(nhlKey(p));
    roster.push({ id: p.id, team: p.team, stints: p.stints, positions, value: v?.value ?? fallback });
    names.set(p.id, p.name);
    info.set(p.id, v);
    if (v && !e.preferred && isOnCurrentNhlRoster(p as DirectoryPlayer)) droppable.add(p.id);
  }
  const activeCount = input.roster.filter((e) => !e.onIr).length;
  const openSpot = Number.isFinite(input.league.rosterSize) && activeCount < input.league.rosterSize;

  // Candidates: current NHL roster skaters with data, never anyone on the user's roster under any id form.
  const candidates: ValuedPlayer[] = [];
  const candInfo = new Map<string, NonNullable<ReturnType<typeof valueOf>>>();
  for (const p of input.directory) {
    if (!isOnCurrentNhlRoster(p) || !isSkater(p.positions)) continue;
    const forms = [p.id, nhlKey(p), p.espnId !== undefined ? `espn-${p.espnId}` : undefined].filter(Boolean) as string[];
    if (forms.some((f) => exclude.has(f))) continue;
    const v = valueOf(nhlKey(p));
    if (!v) continue;
    candidates.push({ id: p.id, team: p.team, stints: p.stints, positions: p.positions.filter((x) => x !== 'G'), value: v.value });
    candInfo.set(p.id, v);
    names.set(p.id, p.name);
  }

  const seats = skaterSeats(expandSeats(input.league.slots));
  const seatedDates = (after: Map<ISODate, DayLineup>, id: string) => dates.filter((d) => after.get(d)?.seated.includes(id));
  const ownPct = (id: string) => input.ownership?.byPlayerId.get(id)?.pct;
  // Score = the gain still left after allowing for the measured estimate error, × the ownership weight
  // (≤ 1, so the score never exceeds the gain). Moves that don't clear the error don't qualify.
  const score = (add: ValuedPlayer, drop: ValuedPlayer | undefined, gain: number, after: Map<ISODate, DayLineup>, before: RosterValue) => {
    const ai = candInfo.get(add.id)!;
    const gx = seatedDates(after, add.id).length;
    const gy = drop ? dates.filter((d) => before.byDate.get(d)?.seated.includes(drop.id)).length : 0;
    const ey = drop ? errorPerGame(info.get(drop.id)!.f.group, scale) : 0;
    const margin = Math.hypot(gx * errorPerGame(ai.f.group, scale), gy * ey);
    const cautious = gain - margin;
    return cautious > 0 ? cautious * ownershipWeight(ownPct(add.id)) : null;
  };
  const res = searchMoves({ roster, droppable, openSpot, candidates, seats, schedule, dates, k: CUSTOM_MAX, score });

  // IR alternative: when the drop is in a prolonged absence (PARTICIPATION.longAbsenceGames+ missed in a
  // row) and an IR slot is free, compare dropping him with keeping him on IR and clearing the weakest other
  // droppable player when he returns, over the playoff rounds (playoff values and availability). The period
  // gain is the same either way (he's off the active roster now); the IR action is shown only when it is
  // strictly better over the playoffs.
  const irUsed = input.roster.filter((e) => e.onIr).length;
  const freeIr = Number.isFinite(input.league.irSlots) ? input.league.irSlots - irUsed : 0;
  const future = input.futureDates ?? (ctx === 'playoffs' ? dates : []);
  const poValue = (id: string, fallbackValue: number) => {
    const p = input.resolve(id) as DirectoryPlayer | undefined;
    const e = p?.nhlId !== undefined ? insights.players[`nhl-${p.nhlId}`] : undefined;
    if (!e?.features) return fallbackValue;
    const v = valuePerGame(perGame(e.features, teamPpSeconds(insights, e.team), 'playoffs'), scale);
    return v === null ? fallbackValue : v;
  };
  const irAlternative = (add: string, drop: string): { laterDrop: string; gainOverDrop: number } | undefined => {
    const q = info.get(drop)?.f.participation;
    if (freeIr <= 0 || !future.length || !q || q.streak < PARTICIPATION.longAbsenceGames) return undefined;
    const addP = candidates.find((c) => c.id === add)!;
    const rosterPo = [...roster, addP].map((p) => ({ ...p, value: poValue(p.id, p.value) }));
    const withDrop = rosterValue(rosterPo.filter((p) => p.id !== drop), seats, schedule, future).total;
    let best: { id: string; total: number } | undefined;
    for (const d of droppable) {
      if (d === drop || d === add) continue;
      const total = rosterValue(rosterPo.filter((p) => p.id !== d), seats, schedule, future).total;
      if (!best || total > best.total + 1e-9) best = { id: d, total };
    }
    return best && best.total > withDrop + 1e-9 ? { laterDrop: best.id, gainOverDrop: best.total - withDrop } : undefined;
  };

  const cards: CustomCard[] = res.moves.map((m) => {
    const ai = candInfo.get(m.add)!;
    const addP = input.directory.find((p) => p.id === m.add)!;
    const lines: InsightLine[] = [];
    const t = talentLine(ai.pg, scale);
    if (t) lines.push(t);
    lines.push(...opportunityLines(ai.f, ctx));
    const xDates = seatedDates(m.after, m.add);
    const xGames = dates.filter((d) => playerGameOn(schedule, addP, d)).length;
    if (ctx === 'playoffs' && input.rounds?.length) {
      lines.push({ kind: 'fit', basis: 'expectation', text: `Lineup games by round: ${input.rounds.map((r) => `${r.name}: ${r.dates.filter((d) => xDates.includes(d)).length}`).join(' · ')}` });
    } else {
      const dropP = m.drop ? input.resolve(m.drop) : undefined;
      const yPart = m.drop && dropP ? ` (${names.get(m.drop)}: ${dates.filter((d) => res.before.byDate.get(d)?.seated.includes(m.drop!)).length} of ${dates.filter((d) => playerGameOn(schedule, dropP, d)).length})` : '';
      lines.push({ kind: 'fit', basis: 'expectation', text: `In your lineup for ${xDates.length} of his ${xGames} games${yPart}` });
    }
    const filled = dates.filter((d) => (m.after.get(d)?.seated.length ?? 0) > (res.before.byDate.get(d)?.seated.length ?? 0));
    if (filled.length) lines.push({ kind: 'fit', basis: 'expectation', text: `Fills an empty lineup spot on ${dateList(filled)}` });
    const own = ownPct(m.add);
    if (own !== undefined) lines.push({ kind: 'ownership', basis: 'fact', text: `Owned in ${Math.round(own)}% of ESPN leagues` });
    lines.push(...availabilityLines(names.get(m.add)!, ai.f));
    const ir = m.drop ? irAlternative(m.add, m.drop) : undefined;
    if (m.drop && !ir) lines.push(...availabilityLines(names.get(m.drop)!, info.get(m.drop)!.f));
    if (ir && m.drop) {
      const y = names.get(m.drop)!;
      const streak = info.get(m.drop)!.f.participation!.streak;
      lines.push({ kind: 'context', basis: 'fact', text: `${y} hasn't played in his team's last ${streak} games (reason unknown). Move him to IR only if he qualifies under your league's rules; the app can't confirm an injury.` });
      lines.push({ kind: 'context', basis: 'expectation', text: `Keeping him on IR is worth more over your playoff rounds than dropping him. When he returns you'd need to clear a roster spot (weakest then: ${names.get(ir.laterDrop)}).` });
    }
    return {
      addId: m.add,
      addName: names.get(m.add)!,
      addTeam: addP.team,
      dropId: ir ? undefined : m.drop,
      dropName: ir ? undefined : m.drop ? names.get(m.drop) : undefined,
      ...(ir && m.drop ? { irId: m.drop, irName: names.get(m.drop), laterDropName: names.get(ir.laterDrop) } : {}),
      headline: ir && m.drop ? `Add ${names.get(m.add)}, move ${names.get(m.drop)} to IR (if eligible)` : m.drop ? `Add ${names.get(m.add)} for ${names.get(m.drop)}` : `Add ${names.get(m.add)} to an open roster spot`,
      lines,
      score: m.score,
      gain: m.gain,
    };
  });

  return { cards, warnings: rosterWarnings(input), goalieSchedule: goalieSchedule(input) };
}

/** Factual roster warnings (shown above the cards; they never take a card's place). */
export function rosterWarnings(input: Pick<CustomInput, 'roster' | 'resolve' | 'insights' | 'teamName'>): string[] {
  const out: string[] = [];
  for (const e of input.roster) {
    const p = input.resolve(e.playerId) as DirectoryPlayer | undefined;
    if (!p || p.nhlId === undefined) continue;
    if (p.inactive) {
      out.push(`${p.name} isn't on an NHL active roster at the latest update.`);
      continue;
    }
    const f = input.insights.players[`nhl-${p.nhlId}`]?.features;
    if (!e.onIr && f && f.teamGamesSinceLast !== null && f.teamGamesSinceLast >= 3) {
      out.push(`${p.name} hasn't played in ${input.teamName(p.team)}'s last ${f.teamGamesSinceLast} games (reason unknown).`);
    }
  }
  return out;
}

/** Back-to-backs within a list of dates, as "Thu–Fri". */
function backToBacks(ds: readonly ISODate[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < ds.length; i++) {
    const a = new Date(`${ds[i - 1]}T12:00:00Z`).getTime();
    const b = new Date(`${ds[i]}T12:00:00Z`).getTime();
    if (b - a === 86_400_000) out.push(`${day(ds[i - 1]!)}–${day(ds[i]!)}`);
  }
  return out;
}

/** Goalie Schedule: verified facts for the user's goalies only. No starts are predicted. */
export function goalieSchedule(input: Pick<CustomInput, 'roster' | 'resolve' | 'insights' | 'schedule' | 'dates' | 'league' | 'scoring' | 'teamName'>): InsightLine[] {
  if (!input.scoring.goalie.length) return [];
  const goalies = input.roster.flatMap((e) => {
    const p = input.resolve(e.playerId);
    return p && !e.onIr && effectivePositions(e, p).includes('G') ? [p] : [];
  });
  if (!goalies.length) return [];
  const lines: InsightLine[] = [];
  for (const g of goalies) {
    const games = input.dates.filter((d) => playerGameOn(input.schedule, g, d));
    const b2b = backToBacks(games);
    lines.push({ kind: 'context', basis: 'fact', text: `${g.name}: ${input.teamName(g.team)} play ${games.length} game${games.length === 1 ? '' : 's'}${b2b.length ? `, back-to-back ${b2b.join(', ')}` : ''}` });
    const s = g.nhlId !== undefined ? input.insights.goalies[`nhl-${g.nhlId}`]?.starts : undefined;
    if (s && s.last10TeamGames >= 5) lines.push({ kind: 'context', basis: 'fact', text: `${g.name} started ${s.startsLast10} of ${input.teamName(g.team)}'s last ${s.last10TeamGames} games` });
  }
  const goalieSeats = expandSeats(input.league.slots).filter((s) => s.accepts.includes('G')).length;
  if (goalieSeats > 0) {
    const empty = input.dates.filter((d) => input.schedule.gamesOn(d).length > 0 && !goalies.some((g) => playerGameOn(input.schedule, g, d)));
    if (empty.length) lines.push({ kind: 'context', basis: 'fact', text: `None of your goalies has a game on ${dateList(empty)}` });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// General Insights: no roster or settings needed.

export interface GeneralItem {
  id: string;
  name: string;
  team: string;
  lines: InsightLine[];
}
export interface GeneralResult {
  roles: GeneralItem[];
  production: GeneralItem[];
  categories: { cat: SkaterCategory; label: string; leaders: { id: string; name: string; team: string; perGame: number }[] }[];
  goalies: GeneralItem[];
}

const HALF_TRUST_FOR: Partial<Record<SkaterCategory, keyof typeof TALENT_HALF_TRUST>> = { hit: 'hit', sog: 'sog', blk: 'blk', ppp: 'ppPts' };

export function generalInsights(input: { insights: InsightsInputsFile; directory: readonly DirectoryPlayer[]; schedule: ScheduleIndex; nextWeek: readonly ISODate[]; teamName: (a: string) => string }): GeneralResult {
  const { insights } = input;
  const dir = new Map(input.directory.filter(isOnCurrentNhlRoster).map((p) => [`nhl-${p.nhlId}`, p]));
  const skaters = Object.entries(insights.players).flatMap(([key, e]) => {
    const p = dir.get(key);
    return p && e.features ? [{ key, p, e, f: e.features }] : [];
  });

  // Confirmed forward PP roles, as factual observations (even-strength changes only support them).
  const roles = skaters
    .filter((s) => s.f.pp.state === 'confirmed' && s.f.group === 'F')
    .sort((a, b) => b.f.pp.rise! - a.f.pp.rise! || (a.key < b.key ? -1 : 1))
    .slice(0, 8)
    .map((s) => {
      const lines = opportunityLines(s.f, 'playoffs').map((l) =>
        l.kind === 'context' ? { ...l, text: `Forwards flagged this way kept about ${pct(PP_PERSISTENCE.retainedNext30)} of the rise over the next 30 games in past seasons, and about ${Math.round(PP_PERSISTENCE.continuedNext30 * 10)} in 10 largely held (provisional). The cause isn't known.` } : l,
      );
      return { id: s.p.id, name: s.p.name, team: s.p.team, lines };
    });

  // Production changes judged on full samples: at least the measured half-trust of games for points, and a
  // change of at least twice the measured typical error.
  const production = skaters
    .flatMap((s) => {
      const pr = s.f.production;
      const need = TALENT_HALF_TRUST.evPts[s.f.group];
      if (pr.gp < need || pr.prevGp < 20 || pr.ptsPg === null || pr.prevPtsPg === null) return [];
      const diff = pr.ptsPg - pr.prevPtsPg;
      if (Math.abs(diff) < 2 * TYPICAL_ERROR_PER_GAME.pts![s.f.group]) return [];
      return [{ s, diff, pr }];
    })
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || (a.s.key < b.s.key ? -1 : 1))
    .slice(0, 6)
    .map(({ s, diff, pr }) => ({
      id: s.p.id,
      name: s.p.name,
      team: s.p.team,
      lines: [{ kind: 'talent' as const, basis: 'fact' as const, text: `${pr.ptsPg!.toFixed(2)} points a game in ${pr.gp} games this season, ${pr.prevPtsPg!.toFixed(2)} last season (${diff > 0 ? 'up' : 'down'})` }],
    }));

  // Category contributors: only once he has at least the measured half-trust of games in that category.
  const categories = (['hit', 'sog', 'blk', 'ppp'] as const).map((cat) => {
    const leaders = skaters
      .filter((s) => s.f.rateGames >= TALENT_HALF_TRUST[HALF_TRUST_FOR[cat]!][s.f.group])
      .map((s) => ({ id: s.p.id, name: s.p.name, team: s.p.team, perGame: perGame(s.f, teamPpSeconds(insights, s.e.team), 'nextWeek')[cat] ?? 0 }))
      .sort((a, b) => b.perGame - a.perGame || (a.id < b.id ? -1 : 1))
      .slice(0, 3);
    return { cat, label: SKATER_CATEGORIES.find((c) => c.id === cat)!.label, leaders };
  }).filter((c) => c.leaders.length > 0);

  // Goalies: verified consecutive starts (gamesStarted) and next week's schedule. Facts only.
  const goalies = Object.entries(insights.goalies)
    .flatMap(([key, g]) => {
      const p = input.directory.find((d) => `nhl-${d.nhlId}` === key && isOnCurrentNhlRoster(d));
      return p && g.starts && g.starts.consecutiveStarts >= 10 ? [{ p, s: g.starts }] : [];
    })
    .sort((a, b) => b.s.consecutiveStarts - a.s.consecutiveStarts || (a.p.id < b.p.id ? -1 : 1))
    .slice(0, 5)
    .map(({ p, s }) => {
      const games = input.nextWeek.filter((d) => input.schedule.teamGameOn(p.team, d));
      const b2b = backToBacks(games);
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        lines: [
          { kind: 'context' as const, basis: 'fact' as const, text: `Started each of ${input.teamName(p.team)}'s last ${s.consecutiveStarts} games` },
          { kind: 'context' as const, basis: 'fact' as const, text: `${input.teamName(p.team)} play ${games.length} game${games.length === 1 ? '' : 's'} next week${b2b.length ? `, back-to-back ${b2b.join(', ')}` : ''}` },
        ],
      };
    });

  return { roles, production, categories, goalies };
}
