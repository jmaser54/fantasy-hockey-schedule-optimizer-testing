import { describe, expect, it } from 'vitest';
import { INSIGHTS_VERSION, type PlayersFile, type SkaterStatsFile } from '../format.ts';
import { insightsTrendsUsable, INSIGHTS_STALE_AFTER_MS, parseInsightsInputs } from '../load.ts';
import { validateInsightsInputs } from '../validate.ts';
import { assembleGames, fetchRange, rangeUrl, type GameRecord, type GameReport } from './gamelog.ts';
import { buildInsightsInputs, insightsUpdateProblems, type SeasonData } from './insightsInputs.ts';
import { applyFetched, contiguousRanges, DEFAULT_CONFIG, emptyWindow, pastNights, planNights } from './insightsWindow.ts';

type Row = Record<string, unknown>;
const TEAM_IDS: Record<string, number> = { BOS: 6, WPG: 52, EDM: 22, CGY: 20 };

/** Rows for one game in the verified per-game report shapes (2026-11-27 probe). */
function gameRows(gameId: number, date: string, home: string, away: string, opts: { homePpToi?: number; awayPpToi?: number; pid0?: number } = {}) {
  const rows: Record<GameReport, Row[]> = { summary: [], scoring: [], toi: [], teamPp: [], teamSum: [], goalie: [] };
  const pid0 = opts.pid0 ?? 8470000;
  [home, away].forEach((team, ti) => {
    const homeRoad = ti === 0 ? 'H' : 'R';
    const teamPpToi = ti === 0 ? (opts.homePpToi ?? 300) : (opts.awayPpToi ?? 200);
    let goals = 0;
    for (let i = 0; i < 18; i++) {
      const playerId = pid0 + ti * 100 + i;
      const g = i === 0 ? 1 : 0;
      goals += g;
      const base = { gameId, gameDate: date, playerId, teamAbbrev: team, homeRoad, gamesPlayed: 1 };
      rows.summary.push({ ...base, goals: g, assists: i === 1 ? 1 : 0, points: g + (i === 1 ? 1 : 0), evPoints: g, ppPoints: i === 1 ? 1 : 0, shots: 2, penaltyMinutes: 0, plusMinus: i % 3 === 0 ? 1 : 0 });
      rows.scoring.push({ ...base, goals: g, totalPrimaryAssists: i === 1 ? 1 : 0, totalSecondaryAssists: 0, hits: 1, blockedShots: 1, shots: 2, penaltyMinutes: 0 });
      const toi = i < 12 ? 900 : 1300;
      rows.toi.push({ ...base, timeOnIce: toi, evTimeOnIce: toi - (i < 4 ? teamPpToi * 0.8 : 0) - 20, ppTimeOnIce: i < 4 ? Math.round(teamPpToi * 0.8) : 0, shTimeOnIce: 20 });
    }
    rows.teamPp.push({ gameId, gameDate: date, teamId: TEAM_IDS[team], homeRoad, ppOpportunities: 3, powerPlayGoalsFor: 1, ppTimeOnIcePerGame: teamPpToi });
    rows.teamSum.push({ gameId, gameDate: date, teamId: TEAM_IDS[team], homeRoad, goalsFor: goals, shotsForPerGame: 36 });
    rows.goalie.push({ gameId, gameDate: date, playerId: pid0 + 50 + ti, teamAbbrev: team, gamesStarted: 1, saves: 33, shotsAgainst: 36, goalsAgainst: 3, timeOnIce: 3600, wins: ti === 0 ? 1 : 0, losses: ti === 0 ? 0 : 1, otLosses: 0 });
  });
  return rows;
}
const merge = (...parts: Record<GameReport, Row[]>[]) =>
  Object.fromEntries((['summary', 'scoring', 'toi', 'teamPp', 'teamSum', 'goalie'] as GameReport[]).map((k) => [k, parts.flatMap((p) => p[k])])) as Record<GameReport, Row[]>;

describe('per-game reports: URLs and paging', () => {
  it('sorts a date range by gameId then playerId (playerId alone duplicated and skipped rows)', () => {
    const u = new URL(rangeUrl('summary', '2026-11-22', '2026-11-25', 100));
    expect(JSON.parse(u.searchParams.get('sort')!)).toEqual([{ property: 'gameId', direction: 'ASC' }, { property: 'playerId', direction: 'ASC' }]);
    expect(u.searchParams.get('isGame')).toBe('true');
    expect(u.searchParams.get('cayenneExp')).toBe('gameTypeId=2 and gameDate<="2026-11-25 23:59:59" and gameDate>="2026-11-22"');
    expect(JSON.parse(new URL(rangeUrl('teamPp', 'a', 'b', 0)).searchParams.get('sort')!)[1].property).toBe('teamId');
  });

  it('pages until total and refuses duplicates, a changing total or rows outside the range', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ gameId: 2026020380 + Math.floor(i / 50), playerId: 8470000 + (i % 50), gameDate: '2026-11-25' }));
    const serve = (data: Row[], total = data.length) => async (url: string) => {
      const start = Number(new URL(url).searchParams.get('start'));
      return { data: data.slice(start, start + 100), total };
    };
    expect((await fetchRange(serve(rows), 'summary', '2026-11-25', '2026-11-25')).length).toBe(250);
    await expect(fetchRange(serve([...rows.slice(0, 249), rows[0]!]), 'summary', '2026-11-25', '2026-11-25')).rejects.toThrow(/duplicate/);
    let calls = 0;
    await expect(fetchRange(async (url) => ({ ...(await serve(rows)(url)), total: 250 + calls++ }), 'summary', '2026-11-25', '2026-11-25')).rejects.toThrow(/total changed/);
    await expect(fetchRange(serve(rows), 'summary', '2026-11-26', '2026-11-26')).rejects.toThrow(/outside/);
  });
});

describe('assembleGames', () => {
  it('joins the six reports into one record per game, keeping missing values as null', () => {
    const rows = gameRows(2026020386, '2026-11-25', 'BOS', 'WPG');
    (rows.scoring[3] as Row).hits = null;
    const { games, rejected } = assembleGames(rows);
    expect(rejected).toEqual([]);
    const g = games.get('2026020386')!;
    expect(g.date).toBe('2026-11-25');
    expect(g.teams.BOS).toEqual({ home: true, gf: 1, sf: 36, ppOpp: 3, ppGoals: 1, ppToi: 300 });
    expect(g.teamIds).toEqual({ BOS: 6, WPG: 52 });
    expect(g.skaters['8470000']!.slice(0, 9)).toEqual(['BOS', 1, 0, 0, 0, 1, 1, 0, 2]);
    expect(g.skaters['8470003']![9]).toBeNull(); // missing hits stays unknown, never 0
    expect(g.goalies['8470050']).toEqual(['BOS', 1, 33, 36, 3, 3600, 'W']);
  });

  it('rejects a game whose reports disagree or look incomplete', () => {
    const cases: [string, (r: Record<GameReport, Row[]>) => void, RegExp][] = [
      ['a skater missing from time on ice', (r) => r.toi.pop(), /different players/],
      ['one team row missing', (r) => r.teamPp.pop(), /team rows/],
      ['player PP time above the team', (r) => ((r.toi[0] as Row).ppTimeOnIce = 999), /PP time above/],
      ['two goalie starts for one team', (r) => r.goalie.push({ ...r.goalie[0]!, playerId: 1 }), /starts/],
      ['too few skaters', (r) => { for (const k of ['summary', 'scoring', 'toi'] as const) r[k] = r[k].slice(6); }, /skaters per team/],
    ];
    for (const [label, mutate, reason] of cases) {
      const rows = gameRows(2026020386, '2026-11-25', 'BOS', 'WPG');
      mutate(rows);
      const res = assembleGames(rows);
      expect([label, res.games.size]).toEqual([label, 0]);
      expect(res.rejected[0]!.reason).toMatch(reason);
    }
  });
});

describe('the rolling window', () => {
  const schedule = [
    { id: '2026020380', date: '2026-11-21' }, { id: '2026020381', date: '2026-11-22' }, { id: '2026020382', date: '2026-11-23' },
    { id: '2026020383', date: '2026-11-25' }, { id: '2026020384', date: '2026-11-25' }, { id: '2026020390', date: '2026-11-27' },
  ];
  const nights = pastNights(schedule, '2026-11-27');
  const cfg = { ...DEFAULT_CONFIG, windowNights: 3, maxNightsPerRun: 2, correctionNights: 1 };

  it('fetches missing nights newest first within the cap, and only past nights', () => {
    expect([...nights.keys()]).toEqual(['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-25']);
    const plan = planNights(emptyWindow('20262027'), nights, '2026-11-27', 6, cfg);
    expect(plan.target).toEqual(['2026-11-22', '2026-11-23', '2026-11-25']);
    expect(plan.fetch).toEqual(['2026-11-25', '2026-11-23']);
    expect(contiguousRanges(['2026-11-25', '2026-11-22'], nights)).toEqual([['2026-11-22', '2026-11-22'], ['2026-11-25', '2026-11-25']]);
    expect(contiguousRanges(['2026-11-25', '2026-11-23', '2026-11-22'], nights)).toEqual([['2026-11-22', '2026-11-25']]);
  });

  it('stores complete and partial nights, counts corrections, drops nights outside the window, and re-fetches recent nights once a day', () => {
    const state = emptyWindow('20262027');
    const all = assembleGames(merge(gameRows(2026020382, '2026-11-23', 'BOS', 'WPG'), gameRows(2026020383, '2026-11-25', 'EDM', 'CGY'))).games;
    const res = applyFetched(state, all, ['2026-11-23', '2026-11-25'], nights, ['2026-11-23', '2026-11-25'], '2026-11-27T12:00:00Z', '2026-11-27');
    expect(res.incompleteNights).toEqual(['2026-11-25']); // 2026020384 missing
    expect(state.meta.nights['2026-11-23']!.status).toBe('complete');
    expect(state.meta.teamAbbrevs).toEqual({ '6': 'BOS', '52': 'WPG', '22': 'EDM', '20': 'CGY' });
    // A correction: the same game with a changed value.
    const changed = assembleGames(gameRows(2026020382, '2026-11-23', 'BOS', 'WPG', { homePpToi: 320 })).games;
    expect(applyFetched(state, changed, ['2026-11-23'], nights, ['2026-11-23', '2026-11-25'], '2026-11-28T13:00:00Z', '2026-11-28').corrected).toBe(1);
    // Nights outside the target are dropped.
    applyFetched(state, new Map(), [], nights, ['2026-11-25'], '2026-11-28T13:00:00Z', '2026-11-28');
    expect(Object.keys(state.nights)).toEqual(['2026-11-25']);
    // Daily correction: not before the correction hour, once per Eastern day.
    const done = emptyWindow('20262027');
    done.meta.nights['2026-11-25'] = { status: 'complete', expected: 2, stored: 2, firstFetchedAt: 'x', fetchedAt: 'x', lastFetchDayEt: '2026-11-26', fetchCount: 1 };
    for (const d of ['2026-11-22', '2026-11-23']) done.meta.nights[d] = { ...done.meta.nights['2026-11-25']! };
    expect(planNights(done, nights, '2026-11-27', 7, cfg).fetch).toEqual([]);
    expect(planNights(done, nights, '2026-11-27', 9, cfg).reasons).toEqual({ '2026-11-25': 'correction' });
    done.meta.nights['2026-11-25']!.lastFetchDayEt = '2026-11-27';
    expect(planNights(done, nights, '2026-11-27', 9, cfg).fetch).toEqual([]);
  });
});

describe('insights inputs', () => {
  const dir = (nhlId: number, team: string, extra: Partial<PlayersFile['players'][number]> = {}) => ({ id: `nhl-${nhlId}`, name: `P${nhlId}`, team, positions: ['C' as const], eligibilitySource: 'nhl' as const, nhlId, ...extra });
  const players: PlayersFile = {
    version: 1, season: '20262027', fetchedAt: 'x', sources: { rosters: 'x', eligibility: { source: 'nhl', detail: 'x' } },
    players: [
      dir(8470000, 'BOS'), dir(8470003, 'BOS'), dir(8470017, 'BOS'),
      dir(8470050, 'BOS', { positions: ['G'] }),
      dir(8470001, 'BOS', { inactive: true }), // dropped off the current-roster feed
      { id: 'espn-1', name: 'Minor', team: 'BOS', positions: ['C'], eligibilitySource: 'espn', espnId: 1, inactive: true },
    ],
  };
  // Six nights of BOS games; the newest night's team PP time is small.
  const dates = ['2026-11-15', '2026-11-17', '2026-11-19', '2026-11-21', '2026-11-23', '2026-11-25'];
  const schedule = dates.map((date, i) => ({ id: String(2026020300 + i), date }));
  const nights = pastNights(schedule, '2026-11-27');
  const target = [...nights.keys()];
  const state = emptyWindow('20262027');
  const games = assembleGames(merge(...dates.map((d, i) => gameRows(2026020300 + i, d, 'BOS', 'WPG', { homePpToi: i === 5 ? 100 : 300 })))).games;
  applyFetched(state, games, target, nights, target, '2026-11-27T12:00:00Z', '2026-11-27');
  const season: SeasonData = {
    fetchedAt: 'x',
    skaters: { '8470000': { gp: 20, g: 8, a: 9, a1: 6, a2: 3, pts: 17, sog: 50, hit: 10, blk: 5, pim: 4, toi: 18000, evToi: 15000, ppToi: 2400, shToi: 600, ppSharePg: 0.7 } },
    teams: { '6': { gp: 20, gfPg: 3.1, sfPg: 30.2, ppPct: 0.22, pkPct: 0.8, ppOpp: 60, ppOppPg: 3, ppGoals: 13, ppToiPg: 330 } },
    goalies: {},
  };
  const stats = { season: '20262027', skaters: [{ nhlId: 8470000, gamesPlayed: 20, points: 17, ppPoints: 5, shPoints: 1, plusMinus: 3 }] } as unknown as SkaterStatsFile;
  const build = (cfg = DEFAULT_CONFIG) => buildInsightsInputs({ state, season, players, skaterStats: stats, target, cfg: { ...cfg, windowNights: 6 }, nowIso: '2026-11-27T12:00:00Z' });

  it('builds last-5 and last-10 windows with Talent and Opportunity apart, and PP share as summed seconds', () => {
    const f = build();
    expect(f.version).toBe(INSIGHTS_VERSION);
    expect([f.complete, f.windowNights, f.windowTarget, f.gamesThrough, f.settledThrough]).toEqual([true, 6, 6, '2026-11-25', '2026-11-19']);
    const p = f.players['nhl-8470000']!;
    expect(p.last5).toMatchObject({ gp: 5, from: '2026-11-17', to: '2026-11-25' });
    expect(p.last5!.talent).toMatchObject({ g: 5, a: 0, pts: 5, evPts: 5, sog: 10, hit: 5, blk: 5 });
    // PP share = Σ player PP seconds ÷ Σ team PP seconds over the same games: (4×240 + 80) / (4×300 + 100).
    expect(p.last5!.opportunity).toMatchObject({ ppToi: 1040, teamPpToi: 1300, ppShare: 0.8 });
    expect(p.last10!.gp).toBe(6);
    expect(p.season!.talent).toMatchObject({ g: 8, evPts: 11, ppp: 5, pm: 3 });
    expect(p.season!.opportunity).toEqual({ toiPg: 900, evToiPg: 750, ppToiPg: 120, shToiPg: 30, ppSharePg: 0.7 });
    expect(f.sources.evidence.opportunity).toMatchObject({ linemates: false, ppUnit: false, teammateQuality: false });
    expect(f.teams.BOS!.season).toMatchObject({ ppPct: 0.22, gfPg: 3.1, sfPg: 30.2 });
    expect(f.teams.BOS!.last10).toMatchObject({ gp: 6, ppOpp: 18, ppGoals: 6, ppPct: 0.3333 });
    expect(f.goalies['nhl-8470050']).toMatchObject({ lastStart: '2026-11-25', last5: { gp: 5, gs: 5, sv: 165, sa: 180, svPct: 0.9167, w: 5 } });
    expect(validateInsightsInputs(f).errors).toEqual([]);
  });

  it('keeps unknowns unknown and includes only current NHL roster players', () => {
    const f = build({ ...DEFAULT_CONFIG, ppShareMinSeconds: 5000 });
    expect(f.players['nhl-8470000']!.last5!.opportunity.ppShare).toBeNull(); // too little team PP time to judge
    expect(f.players['nhl-8470003']!.last5!.talent.hit).toBe(5);
    expect(f.players['nhl-8470001']).toBeUndefined(); // off the current-roster feed
    expect(Object.keys(f.players).some((k) => k.startsWith('espn-'))).toBe(false);
    expect(f.players['nhl-8470003']!.season).toBeUndefined(); // no season row → no block, not zeros
    const s2 = emptyWindow('20262027');
    const g = assembleGames(gameRows(2026020300, '2026-11-15', 'BOS', 'WPG')).games;
    (g.get('2026020300') as GameRecord).skaters['8470003']![9] = null;
    applyFetched(s2, g, ['2026-11-15'], nights, target, 'x', '2026-11-27');
    const f2 = buildInsightsInputs({ state: s2, season, players, skaterStats: stats, target, cfg: DEFAULT_CONFIG, nowIso: 'x' });
    expect(f2.players['nhl-8470003']!.last5!.talent.hit).toBeNull();
    expect(f2.complete).toBe(false);
  });

  it('validates the file and refuses an incomplete or shrinking update', () => {
    const f = build();
    expect(validateInsightsInputs({ ...f, players: { 'nhl-1': { team: 'BOS', last5: { ...f.players['nhl-8470000']!.last5!, opportunity: { ...f.players['nhl-8470000']!.last5!.opportunity, ppShare: 1.2 } } } } }).errors.join()).toMatch(/ppShare/);
    expect(validateInsightsInputs({ ...f, players: { 'nhl-1': { team: 'BOS', last5: { ...f.players['nhl-8470000']!.last10!, gp: 6 } } } }).errors.join()).toMatch(/games 6/);
    expect(insightsUpdateProblems(f, undefined, players, stats, true)).toEqual([]);
    const statsMore = { season: '20262027', skaters: [8470000, 8470003, 8470017].map((nhlId) => ({ nhlId, gamesPlayed: 5, points: 0, ppPoints: 0, shPoints: 0, plusMinus: 0 })) } as unknown as SkaterStatsFile;
    expect(insightsUpdateProblems(f, undefined, players, statsMore, true).join()).toMatch(/season block/);
    const bigger = { ...f, players: { ...f.players, ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`nhl-${9000 + i}`, { team: 'BOS' }])) } };
    expect(insightsUpdateProblems(f, bigger, players, stats, true).join()).toMatch(/players fell/);
  });

  it('loads optionally and uses trends only when complete and fresh', () => {
    const f = build();
    expect(parseInsightsInputs(f, '20262027')).toBe(f);
    expect(parseInsightsInputs({ ...f, version: 9 }, '20262027')).toBeUndefined();
    expect(parseInsightsInputs(f, '20272028')).toBeUndefined();
    const t = Date.parse(f.generatedAt);
    expect(insightsTrendsUsable(f, t + INSIGHTS_STALE_AFTER_MS)).toBe(true);
    expect(insightsTrendsUsable(f, t + INSIGHTS_STALE_AFTER_MS + 1)).toBe(false);
    expect(insightsTrendsUsable({ ...f, complete: false }, t)).toBe(false);
    expect(insightsTrendsUsable(undefined)).toBe(false);
  });
});
