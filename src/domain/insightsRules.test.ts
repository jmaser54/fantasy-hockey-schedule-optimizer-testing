import { describe, expect, it } from 'vitest';
import { INSIGHTS_VERSION, type InsightsInputsFile, type SkaterFeatures } from '../data/format.ts';
import { ownershipForRanking, type DirectoryPlayer, type OwnershipData } from '../data/load.ts';
import { eachDate } from './dates.ts';
import { customInsights, generalInsights, rosterIdForms, type CustomInput } from './insightsRules.ts';
import { ownershipWeight } from './insightsValue.ts';
import { DEFAULT_LEAGUE } from './league.ts';
import { ScheduleIndex } from './schedule.ts';
import { DEFAULT_SCORING } from './scoring.ts';
import type { Game, Player, RosterEntry } from './types.ts';

const week = eachDate('2027-03-01', '2027-03-07');
const rounds = [{ name: 'Round 1', dates: eachDate('2027-03-08', '2027-03-14') }, { name: 'Round 2', dates: eachDate('2027-03-15', '2027-03-21') }];
// Every team plays every day (simple and dense): AAA–BBB, CCC–DDD.
const games: Game[] = eachDate('2027-03-01', '2027-03-21').flatMap((d, i) => [
  { id: `a${i}`, date: d, home: 'AAA', away: 'BBB' },
  { id: `c${i}`, date: d, home: 'CCC', away: 'DDD' },
]);
const schedule = new ScheduleIndex(games);

/** Features with a single "quality" knob q (points and shots scale with it). */
function feat(q: number, o: Partial<SkaterFeatures> & { evNext?: number; evPlayoffs?: number } = {}): SkaterFeatures {
  const ev = { toi: 16, evToi: 13, shToi: 1, ppShare: 0.3 };
  return {
    group: 'F',
    rates: { evPts: 1.5 * q, ppPts: 4 * q, shPts: 0.5, evG: 0.6 * q, ppG: 1.5 * q, shG: 0.2, sog: 7 * q, hit: 4, blk: 2, pim: 2, pm: 0, fow: 0 },
    rateGames: 30,
    prior: 'player',
    minutes: { nextWeek: { ...ev, evToi: o.evNext ?? 13, toi: (o.evNext ?? 13) + 3 }, playoffs: { ...ev, evToi: o.evPlayoffs ?? 13, toi: (o.evPlayoffs ?? 13) + 3 } },
    pp: { state: 'none', usableGames: 30, baseline: 0.3, recent: 0.3, rise: 0, elevated: 0, latestElevated: false },
    evMinutes: { last5: 13, window: 13, windowGames: 30 },
    lastGame: '2027-02-28',
    teamGamesSinceLast: 0,
    production: { gp: 30, ptsPg: 0.5, prevGp: 80, prevPtsPg: 0.5 },
    ...o,
  };
}
const dirP = (n: number, team: string, extra: Partial<DirectoryPlayer> = {}): DirectoryPlayer => ({ id: `nhl-${n}`, name: `P${n}`, team, positions: ['C'], eligibilitySource: 'espn', nhlId: n, espnId: 9000 + n, ...extra });

function setup(over: { players?: Record<number, SkaterFeatures>; directory?: DirectoryPlayer[] } = {}) {
  // Roster: 4 C on AAA/BBB (one ★, one IR), plus pool of free agents.
  const directory: DirectoryPlayer[] = over.directory ?? [
    dirP(1, 'AAA'), dirP(2, 'AAA'), dirP(3, 'BBB'), dirP(4, 'BBB'),
    dirP(10, 'CCC'), dirP(11, 'CCC'), dirP(12, 'DDD'), dirP(13, 'DDD'),
    dirP(20, 'CCC', { positions: ['G'] }),
  ];
  const fl: Record<number, SkaterFeatures> = over.players ?? { 1: feat(0.5), 2: feat(0.4), 3: feat(1.2), 4: feat(1.1), 10: feat(1.6), 11: feat(0.6), 12: feat(0.9), 13: feat(0.7) };
  const insights: InsightsInputsFile = {
    version: INSIGHTS_VERSION, season: '20262027', generatedAt: '2027-02-28T12:00:00Z', gamesThrough: '2027-02-27', settledThrough: null, windowNights: 80, windowTarget: 80, complete: true,
    settings: { ppShareMinSeconds: 240, correctionNights: 3 },
    sources: { gameLogs: 'x', season: 'x', evidence: { talent: true, opportunity: { toi: true, ppShare: true, linemates: false, ppUnit: false, teammateQuality: false } } },
    players: Object.fromEntries(Object.entries(fl).map(([n, f]) => [`nhl-${n}`, { team: directory.find((d) => d.nhlId === Number(n))?.team ?? 'AAA', features: f }])),
    league: { ppToiPg: 300 },
    teams: {},
    goalies: { 'nhl-20': { team: 'CCC', lastStart: '2027-02-27', starts: { teamGames: 30, starts: 28, last10TeamGames: 10, startsLast10: 9, consecutiveStarts: 12 } } },
  };
  const byId = new Map(directory.map((p) => [p.id, p]));
  const resolve = (id: string): Player | undefined => byId.get(id) ?? directory.find((p) => `espn-${p.espnId}` === id);
  return { directory, insights, resolve };
}
const league = { ...DEFAULT_LEAGUE, rosterSize: 6, slots: [{ id: 'C', label: 'C', count: 2, accepts: ['C' as const] }, { id: 'G', label: 'G', count: 1, accepts: ['G' as const] }] };
const roster: RosterEntry[] = [
  { playerId: 'nhl-1', onIr: false, preferred: true }, // weakest, but ★
  { playerId: 'nhl-2', onIr: true }, // IR
  { playerId: 'nhl-3', onIr: false },
  { playerId: 'nhl-4', onIr: false },
  { playerId: 'nhl-20', onIr: false },
];
const base = (s: ReturnType<typeof setup>, o: Partial<CustomInput> = {}): CustomInput => ({
  ctx: 'nextWeek', dates: week, rounds, roster, resolve: s.resolve, directory: s.directory, league: { ...league, rosterSize: 4 }, scoring: { ...DEFAULT_SCORING, confirmed: true, skater: ['g', 'a', 'pts', 'ppp', 'sog'] },
  insights: s.insights, ownership: undefined, schedule, teamName: (t) => t, ...o,
});

describe('Custom Insights', () => {
  it('recommends the best outside player, never anyone on the roster, and never drops ★ or IR players', () => {
    const s = setup();
    const r = customInsights(base(s));
    expect(r.cards.length).toBeGreaterThan(0);
    expect(r.cards[0]!.addId).toBe('nhl-10');
    const rostered = rosterIdForms(roster, s.resolve);
    for (const c of r.cards) {
      expect(rostered.has(c.addId)).toBe(false);
      expect(['nhl-1', 'nhl-2']).not.toContain(c.dropId);
    }
  });

  it('excludes rostered players under every id form (an espn- saved id still hides the nhl- player)', () => {
    const s = setup();
    const r = customInsights(base(s, { roster: [...roster.slice(0, 4), { playerId: 'espn-9010', onIr: false }, roster[4]!], league: { ...league, rosterSize: 5 } }));
    expect(r.cards.map((c) => c.addId)).not.toContain('nhl-10');
  });

  it('only considers current NHL roster players', () => {
    const s = setup();
    s.directory.find((p) => p.nhlId === 10)!.inactive = true;
    expect(customInsights(base(s)).cards.map((c) => c.addId)).not.toContain('nhl-10');
  });

  it('never pads: no card when no move clears the measured error range', () => {
    const s = setup({ players: { 1: feat(1), 2: feat(1), 3: feat(1), 4: feat(1), 10: feat(1.02), 11: feat(0.5), 12: feat(0.5), 13: feat(0.5) } });
    expect(customInsights(base(s)).cards).toEqual([]);
  });

  it('shows a confirmed forward PP role only inside a card that passes the value and fit test', () => {
    const confirmedPp = { state: 'confirmed' as const, usableGames: 40, baseline: 0.2, recent: 0.5, rise: 0.3, elevated: 7, latestElevated: true };
    // A confirmed but weak player: no card, so no promotion anywhere in Custom Insights.
    const weak = setup();
    weak.insights.players['nhl-11']!.features = feat(0.6, { pp: confirmedPp });
    const r1 = customInsights(base(weak));
    expect(r1.cards.map((c) => c.addId)).not.toContain('nhl-11');
    expect(JSON.stringify(r1)).not.toMatch(/Power-play share up/);
    // A confirmed, strong player: the PP fact appears inside his card with its expectation line.
    const strong = setup();
    strong.insights.players['nhl-10']!.features = feat(1.6, { pp: confirmedPp });
    const card = customInsights(base(strong)).cards.find((c) => c.addId === 'nhl-10')!;
    expect(card.lines.find((l) => l.text.startsWith('Power-play share up'))!.basis).toBe('fact');
    expect(card.lines.find((l) => l.kind === 'context')!.text).toMatch(/87%.*provisional/);
  });

  it('never calls an observed rise a promotion, and treats a defenceman or even-strength change as supporting only', () => {
    const s = setup();
    s.insights.players['nhl-10']!.features = feat(1.6, { pp: { state: 'observed', usableGames: 40, baseline: 0.2, recent: 0.35, rise: 0.15, elevated: 3, latestElevated: true }, evMinutes: { last5: 16, window: 13, windowGames: 30 } });
    const text = JSON.stringify(customInsights(base(s)));
    expect(text).not.toMatch(/promot|up from/i);
    expect(text).toMatch(/Even-strength ice time/);
  });

  it('MacKinnon case: a brief even-strength jump is a Next Week move but not a Playoff Edge move', () => {
    const s = setup({ players: { 1: feat(0.5), 2: feat(0.4), 3: feat(1.0), 4: feat(1.0), 10: feat(0.9, { evNext: 24, evPlayoffs: 13.5 }), 11: feat(0.5), 12: feat(0.5), 13: feat(0.5) } });
    expect(customInsights(base(s)).cards.map((c) => c.addId)).toContain('nhl-10');
    expect(customInsights(base(s, { ctx: 'playoffs', dates: rounds.flatMap((r) => r.dates) })).cards.map((c) => c.addId)).not.toContain('nhl-10');
  });

  it('ranks with ownership as a preference only; missing or stale ownership is neutral', () => {
    const s = setup({ players: { 1: feat(0.5), 2: feat(0.4), 3: feat(1.0), 4: feat(1.0), 10: feat(1.5), 11: feat(1.45), 12: feat(0.4), 13: feat(0.4) } });
    const none = customInsights(base(s)).cards.map((c) => c.addId);
    expect(none[0]).toBe('nhl-10');
    const own: OwnershipData = { season: '20262027', fetchedAt: '2027-02-28T00:00:00Z', byPlayerId: new Map([['nhl-10', { espnId: 1, pct: 80 }], ['nhl-11', { espnId: 2, pct: 3 }]]) };
    const withOwn = customInsights(base(s, { ownership: own }));
    expect(withOwn.cards[0]!.addId).toBe('nhl-11');
    expect(withOwn.cards[0]!.lines.find((l) => l.kind === 'ownership')!.text).toBe('Owned in 3% of ESPN leagues');
    expect(JSON.stringify(withOwn)).not.toMatch(/available/i);
  });

  it('participation: only a current prolonged absence lowers Next Week value; playoff value is never discounted', () => {
    const playoffs = (s: ReturnType<typeof setup>) => customInsights(base(s, { ctx: 'playoffs', dates: rounds.flatMap((r) => r.dates) }));
    const s = setup();
    // The best candidate has missed his team's last 17 games: not a Next Week add, still a playoff one.
    s.insights.players['nhl-10']!.features = feat(1.6, { participation: { teamGames: 26, played: 9, streak: 17, nextWeek: 0.1 } });
    expect(customInsights(base(s)).cards.map((c) => c.addId)).not.toContain('nhl-10');
    const po = playoffs(s).cards.find((c) => c.addId === 'nhl-10')!;
    expect(po).toBeDefined();
    expect(po.lines.map((l) => l.text)).toContain("P10 hasn't played in his team's last 17 games (reason unknown). Check his status before acting.");
    // A rostered player in a prolonged absence becomes the natural Next Week drop even though his per-game value is high.
    const t = setup();
    t.insights.players['nhl-3']!.features = feat(1.2, { participation: { teamGames: 26, played: 5, streak: 21, nextWeek: 0.05 } });
    expect(customInsights(base(t)).cards[0]!.dropId).toBe('nhl-3');
  });

  it('participation: 1–4 missed games never lower value (only a factual line), even from an older file\'s share', () => {
    const plain = customInsights(base(setup())).cards;
    const s = setup();
    s.insights.players['nhl-10']!.features = feat(1.6, { participation: { teamGames: 26, played: 24, streak: 2, nextWeek: 0.4 } });
    const cards = customInsights(base(s)).cards;
    expect(cards.map((c) => [c.addId, c.dropId, Math.round(c.gain * 1e6)])).toEqual(plain.map((c) => [c.addId, c.dropId, Math.round(c.gain * 1e6)]));
    const lines = cards.find((c) => c.addId === 'nhl-10')!.lines.map((l) => l.text);
    expect(lines).toContain("P10 hasn't played in his team's last 2 games (reason unknown). Check his status before acting.");
    expect(lines.join(' ')).not.toMatch(/dressed for/i); // 24 of 26 isn't notable
  });

  it('participation: a returned player is valued in full; his dressing record is a fact, shown only when notable', () => {
    const plain = customInsights(base(setup())).cards;
    const s = setup();
    s.insights.players['nhl-10']!.features = feat(1.6, { participation: { teamGames: 25, played: 3, streak: 0, nextWeek: 1 } });
    const cards = customInsights(base(s)).cards;
    expect(cards.map((c) => Math.round(c.gain * 1e6))).toEqual(plain.map((c) => Math.round(c.gain * 1e6)));
    const lines = cards.find((c) => c.addId === 'nhl-10')!.lines;
    expect(lines.filter((l) => /dressed for/i.test(l.text))).toEqual([{ kind: 'context', basis: 'fact', text: 'P10 dressed for 3 of his team\'s last 25 games' }]);
    expect(lines.map((l) => l.text).join(' ')).not.toMatch(/hasn't played/);
    // When every miss is the current run, the run's own line says it; no dressing line too.
    const t = setup();
    t.insights.players['nhl-10']!.features = feat(1.6, { participation: { teamGames: 26, played: 23, streak: 3, nextWeek: 1 } });
    expect(customInsights(base(t)).cards.find((c) => c.addId === 'nhl-10')!.lines.map((l) => l.text).join(' ')).not.toMatch(/dressed for/i);
  });

  it('IR alternative: keeps a prolonged absentee on IR instead of dropping him, only when that is better and a slot is free', () => {
    const absent = (q: number) => feat(q, { participation: { teamGames: 26, played: 14, streak: 10, nextWeek: 0.05 } });
    const playoffDates = rounds.flatMap((r) => r.dates);
    const s = setup();
    s.insights.players['nhl-3']!.features = absent(1.5); // valuable, out now, back for the playoffs
    const card = customInsights(base(s, { futureDates: playoffDates })).cards[0]!;
    expect(card.irId).toBe('nhl-3');
    expect(card.dropId).toBeUndefined();
    expect(card.headline).toMatch(/move P3 to IR \(if eligible\)/);
    expect(card.laterDropName).toBe('P4');
    const text = card.lines.map((l) => l.text).join(' ');
    expect(text).toMatch(/only if he qualifies under your league's rules; the app can't confirm an injury/i);
    expect(text).not.toMatch(/\bis injured\b|\binjured\b/i);
    // No free IR slot (2 slots: one already used, fill the other): the drop stays.
    const full = customInsights(base(s, { futureDates: playoffDates, league: { ...league, rosterSize: 4, irSlots: 1 } })).cards[0]!;
    expect(full.dropId).toBe('nhl-3');
    expect(full.irId).toBeUndefined();
    // Not a prolonged absence: the drop stays.
    const t = setup();
    t.insights.players['nhl-3']!.features = feat(0.1, { participation: { teamGames: 26, played: 24, streak: 2, nextWeek: 1 } });
    expect(customInsights(base(t, { futureDates: playoffDates })).cards.every((c) => !c.irId)).toBe(true);
    // Keeping him isn't better (his playoff value is below everyone else's): the drop stays.
    const u = setup();
    u.insights.players['nhl-3']!.features = absent(0.1);
    const c3 = customInsights(base(u, { futureDates: playoffDates })).cards[0]!;
    expect(c3.irId).toBeUndefined();
    expect(c3.dropId).toBe('nhl-3');
  });

  it('treats missing ownership as 1.0 (no bonus or penalty), a stale file as no ownership, and never filters on it', () => {
    expect([ownershipWeight(undefined), ownershipWeight(3), ownershipWeight(10), ownershipWeight(29.9), ownershipWeight(30), ownershipWeight(100)]).toEqual([1, 1, 0.6, 0.6, 0.3, 0.3]);
    const s = setup({ players: { 1: feat(0.5), 2: feat(0.4), 3: feat(1.0), 4: feat(1.0), 10: feat(1.5), 11: feat(1.45), 12: feat(0.4), 13: feat(0.4) } });
    const unweighted = customInsights(base(s)).cards;
    // nhl-11 is known low-owned; nhl-10 is missing from the file: both 1.0, so pure value decides.
    const partial: OwnershipData = { season: '20262027', fetchedAt: '2027-02-28T00:00:00Z', byPlayerId: new Map([['nhl-11', { espnId: 2, pct: 3 }]]) };
    const r = customInsights(base(s, { ownership: partial })).cards;
    expect(r.map((c) => [c.addId, c.score])).toEqual(unweighted.map((c) => [c.addId, c.score]));
    // A stale file is dropped before ranking (ownershipForRanking), which is the same as no ownership at all.
    const stale: OwnershipData = { ...partial, fetchedAt: '2027-02-20T00:00:00Z' };
    expect(ownershipForRanking(stale, Date.parse('2027-02-28T12:00:00Z'))).toBeUndefined();
    // Even 100% ownership for everyone never removes a candidate: the same players qualify, only scores scale.
    const everyone: OwnershipData = { ...partial, byPlayerId: new Map(s.directory.map((p, i) => [p.id, { espnId: i + 1, pct: 100 }])) };
    const all = customInsights(base(s, { ownership: everyone })).cards;
    expect(all.map((c) => c.addId).sort()).toEqual(unweighted.map((c) => c.addId).sort());
  });

  it('shows roster warnings without displacing cards, and a factual Goalie Schedule', () => {
    const s = setup();
    const before = customInsights(base(s)).cards.length;
    s.insights.players['nhl-4']!.features = feat(1.1, { teamGamesSinceLast: 4 });
    const r = customInsights(base(s));
    expect(r.cards.length).toBe(before);
    expect(r.warnings).toEqual(["P4 hasn't played in BBB's last 4 games (reason unknown)."]);
    const goalieText = r.goalieSchedule.map((l) => l.text).join(' | ');
    expect(goalieText).toMatch(/P20: CCC play 7 games, back-to-back/);
    expect(goalieText).toMatch(/started 9 of CCC's last 10 games/);
    expect(r.goalieSchedule.every((l) => l.basis === 'fact')).toBe(true);
    expect(goalieText).not.toMatch(/will start|starter|take(n)? over|takeover|likely|expected to/i);
  });
});

describe('General Insights', () => {
  it('needs no roster and lists confirmed forward PP roles, never observed rises, defencemen or even-strength-only changes', () => {
    const s = setup();
    const confirmedPp = { state: 'confirmed' as const, usableGames: 40, baseline: 0.2, recent: 0.5, rise: 0.3, elevated: 7, latestElevated: true };
    s.insights.players['nhl-10']!.features = feat(1.6, { pp: confirmedPp });
    s.insights.players['nhl-11']!.features = feat(0.6, { pp: { ...confirmedPp, state: 'observed' } });
    s.insights.players['nhl-12']!.features = feat(0.9, { group: 'D', pp: confirmedPp }); // invalid in real data; still excluded
    s.insights.players['nhl-13']!.features = feat(0.7, { evMinutes: { last5: 18, window: 13, windowGames: 30 } });
    const g = generalInsights({ insights: s.insights, directory: s.directory, schedule, nextWeek: week, teamName: (t) => t });
    expect(g.roles.map((r) => r.id)).toEqual(['nhl-10']);
    expect(JSON.stringify(g)).not.toMatch(/promot/i);
    expect(g.goalies[0]!.lines.map((l) => l.text)).toEqual(["Started each of CCC's last 12 games", 'CCC play 7 games next week, back-to-back Mon–Tue, Tue–Wed, Wed–Thu, Thu–Fri, Fri–Sat, Sat–Sun']);
    expect(JSON.stringify(g.goalies)).not.toMatch(/will start|starter|takeover|likely/i);
  });
});
