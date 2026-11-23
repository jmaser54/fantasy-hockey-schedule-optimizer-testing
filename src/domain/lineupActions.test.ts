import { describe, expect, it } from 'vitest';
import { initialState, reducer, type AppState } from '../state/appState.ts';
import { addOptions, gameKind, inAutomaticLineup, lineupOf, moveOptions, overrideFor, planIrChange, replaceOptions, summarizeDays } from './lineupActions.ts';
import { expandSeats, optimizeDates, optimizeDay, type LineupPlayer } from './optimizer.ts';
import { toLineupPlayers } from './roster.ts';
import { player, sched, slots } from './testUtils.ts';
import type { Player, Position } from './types.ts';

// Two C slots and one UTIL; three centers and a winger whose teams all play on Nov 17 and 18.
const DATES = ['2026-11-17', '2026-11-18', '2026-11-19'];
const s = sched([
  ['2026-11-17', 'EDM', 'TOR'],
  ['2026-11-17', 'COL', 'ANA'],
  ['2026-11-18', 'EDM', 'COL'],
  ['2026-11-18', 'TOR', 'ANA'],
  ['2026-11-19', 'EDM', 'TOR'],
]);
const P = (id: string, team: string, positions: Position[]): Player => ({ id, name: id, team, positions, eligibilitySource: 'nhl' });
const directory = new Map(
  [P('mcdavid', 'EDM', ['C']), P('matthews', 'TOR', ['C']), P('mackinnon', 'COL', ['C']), P('carlsson', 'ANA', ['C']), P('goalie', 'EDM', ['G'])].map((p) => [p.id, p]),
);
const league = { rosterSize: 22, irSlots: 2, slots: slots({ C: [2, ['C']], UTIL: ['C', 'LW', 'RW', 'D'] }) };
const seats = expandSeats(league.slots);
const roster = (st: AppState) => toLineupPlayers(st.roster, directory);
const days = (st: AppState) => optimizeDates(DATES, roster(st), st.league, s, st.manual);
const start = () => reducer({ ...initialState(), league }, { type: 'addPlayers', ids: ['mcdavid', 'matthews', 'mackinnon', 'carlsson'] });
/** Save a new lineup for one date, as the grid sheets do. */
const save = (st: AppState, date: string, next: Record<string, string | null>) =>
  reducer(st, { type: 'setManual', date, override: overrideFor(date, next, roster(st), seats, s, st.manual[date]?.notes) });

describe('manual changes from the grid', () => {
  it('stay on the selected date: other dates keep their lineups', () => {
    let st = start();
    const before = days(st);
    const day = before.get('2026-11-17')!;
    const benchMcDavid = moveOptions(day, 'mcdavid', roster(st), seats).find((o) => o.seatLabel === 'Bench')!;
    st = save(st, '2026-11-17', benchMcDavid.next);
    expect(Object.keys(st.manual)).toEqual(['2026-11-17']);
    const after = days(st);
    expect(after.get('2026-11-17')!.players.find((x) => x.playerId === 'mcdavid')!.seatKey).toBeUndefined();
    for (const d of ['2026-11-18', '2026-11-19']) expect(lineupOf(after.get(d)!)).toEqual(lineupOf(before.get(d)!));
  });

  it('a change back to the automatic lineup clears the date', () => {
    let st = start();
    const auto = lineupOf(days(st).get('2026-11-17')!);
    st = save(st, '2026-11-17', moveOptions(days(st).get('2026-11-17')!, 'mcdavid', roster(st), seats).find((o) => o.seatLabel === 'Bench')!.next);
    st = save(st, '2026-11-17', auto);
    expect(st.manual).toEqual({});
  });

  it('replacement suggestions name the game gained and the game given up, lowest priority first', () => {
    let st = reducer(start(), { type: 'updateEntry', id: 'matthews', patch: { preferred: true } });
    const day = days(st).get('2026-11-17')!; // 4 centers play, 3 seats: carlsson (last, not preferred) sits
    expect(gameKind(day, 'carlsson', new Map(roster(st).map((p) => [p.id, p])), seats)).toBe('priority');
    const opts = addOptions(day, 'carlsson', roster(st), seats);
    expect(opts.every((o) => o.kind === 'replace')).toBe(true);
    const gameOf = (id: string) => day.players.find((x) => x.playerId === id)!.game;
    for (const o of opts) {
      expect(o.gain).toBe(gameOf('carlsson'));
      expect(o.lose).toBe(gameOf(o.outId!));
      expect(o.next[o.seatKey]).toBe('carlsson');
      expect(Object.values(o.next)).not.toContain(o.outId);
    }
    // Suggested: the lowest-priority starter (mackinnon: not preferred, latest in roster order among starters).
    expect(opts[0]).toMatchObject({ suggested: true, outId: 'mackinnon' });
    expect(opts.find((o) => o.outId === 'matthews')?.suggested).toBeUndefined();
    // Applying it changes only that date.
    st = save(st, '2026-11-17', opts[0]!.next);
    expect(Object.keys(st.manual)).toEqual(['2026-11-17']);
    expect(days(st).get('2026-11-17')!.usable).toBe(3);
  });

  it('a game your change left out is an opportunity, with an open option that gives nothing up', () => {
    let st = start();
    st = save(st, '2026-11-17', moveOptions(days(st).get('2026-11-17')!, 'mcdavid', roster(st), seats).find((o) => o.seatLabel === 'Bench')!.next);
    const day = days(st).get('2026-11-17')!;
    const players = new Map(roster(st).map((p) => [p.id, p]));
    expect(gameKind(day, 'mcdavid', players, seats)).toBe('opportunity');
    expect(inAutomaticLineup('2026-11-17', 'mcdavid', roster(st), seats, s)).toBe(true);
    const [first] = addOptions(day, 'mcdavid', roster(st), seats);
    expect(first).toMatchObject({ kind: 'open' });
    expect(first!.lose).toBeUndefined();
    st = save(st, '2026-11-17', first!.next);
    expect(st.manual).toEqual({}); // back to the automatic lineup
  });

  it('a player no slot accepts is a constraint, not an opportunity', () => {
    const st = reducer(start(), { type: 'addPlayers', ids: ['goalie'] });
    const day = days(st).get('2026-11-17')!;
    expect(gameKind(day, 'goalie', new Map(roster(st).map((p) => [p.id, p])), seats)).toBe('constraint');
    expect(addOptions(day, 'goalie', roster(st), seats)).toEqual([]);
  });
});

describe('optimal baseline and opportunity indicators', () => {
  it('automatic days never show an opportunity (random rosters)', () => {
    const teams = ['EDM', 'TOR', 'COL', 'ANA', 'BOS', 'NYR'];
    const pos: Position[][] = [['C'], ['LW'], ['RW'], ['D'], ['C', 'LW'], ['LW', 'RW'], ['G'], ['C', 'RW']];
    const rs = sched(['2026-12-01', '2026-12-02', '2026-12-03'].flatMap((d, i) => [[d, teams[i]!, teams[i + 1]!] as [string, string, string], [d, teams[i + 2]!, teams[i + 3]!] as [string, string, string]]));
    const fullSeats = expandSeats(slots({ C: [2, ['C']], LW: [2, ['LW']], RW: [2, ['RW']], D: [2, ['D']], UTIL: ['C', 'LW', 'RW', 'D'], G: [2, ['G']] }));
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 9301 + 49297) % 233280), Math.floor((seed / 233280) * n));
    for (let trial = 0; trial < 60; trial++) {
      const r: LineupPlayer[] = Array.from({ length: 10 + rnd(10) }, (_, i) => ({ ...player(`p${i}`, teams[rnd(teams.length)]!, pos[rnd(pos.length)]!, rnd(10) === 0), preferred: rnd(4) === 0 }));
      const players = new Map(r.map((p) => [p.id, p]));
      for (const d of ['2026-12-01', '2026-12-02', '2026-12-03']) {
        const day = optimizeDay(d, r, fullSeats, rs);
        for (const p of r) expect(gameKind(day, p.id, players, fullSeats)).not.toBe('opportunity');
        // In-lineup games are exactly the day's usable games.
        expect(r.filter((p) => gameKind(day, p.id, players, fullSeats) === 'in-lineup').length).toBe(day.usable);
      }
    }
  });
});

describe('IR changes', () => {
  it('moving a starter to IR re-optimizes the selected period: automatic days refill on their own', () => {
    const st = start();
    const plan = planIrChange('mcdavid', true, roster(st), DATES, seats, s, st.manual);
    expect(plan.manual).toEqual({}); // no edited days: nothing to save, the optimizer refills
    const nov17 = plan.changes.find((c) => c.date === '2026-11-17')!;
    expect(nov17.removed).toEqual(['mcdavid']);
    expect(nov17.added).toEqual(['carlsson']); // the bench player with a game takes the spot
    const after = reducer(st, { type: 'applyIrChange', id: 'mcdavid', onIr: true, manual: plan.manual });
    expect(after.roster.find((e) => e.playerId === 'mcdavid')!.onIr).toBe(true);
    expect(days(after).get('2026-11-17')!.usable).toBe(3);
    expect(plan.after).toBe([...days(after).values()].reduce((n, d) => n + d.usable, 0));
  });

  it('on a day you changed, only the IR player’s seat is refilled; the rest of your lineup stays', () => {
    let st = reducer(start(), { type: 'updateEntry', id: 'matthews', patch: { preferred: true } });
    // Your change on Nov 17: Carlsson replaces MacKinnon.
    const opt = addOptions(days(st).get('2026-11-17')!, 'carlsson', roster(st), seats).find((o) => o.outId === 'mackinnon')!;
    st = save(st, '2026-11-17', opt.next);
    const mine = st.manual['2026-11-17']!.lineup!;
    const plan = planIrChange('mcdavid', true, roster(st), DATES, seats, s, st.manual);
    expect('2026-11-17' in plan.manual).toBe(true);
    const after = reducer(st, { type: 'applyIrChange', id: 'mcdavid', onIr: true, manual: plan.manual });
    // Saved as is, or cleared when the refilled lineup equals the automatic one; either way the day shows:
    const shown = lineupOf(days(after).get('2026-11-17')!);
    const mcSeat = Object.keys(mine).find((k) => mine[k] === 'mcdavid')!;
    expect(shown[mcSeat]).toBe('mackinnon'); // the bench player with a game fills McDavid's seat
    for (const k of Object.keys(mine)) if (k !== mcSeat) expect(shown[k]).toBe(mine[k]); // nobody else moves
    expect(days(after).get('2026-11-17')!.manualIssues).toEqual([]);
    expect(plan.changes.find((c) => c.date === '2026-11-17')).toEqual({ date: '2026-11-17', added: ['mackinnon'], removed: ['mcdavid'] });
  });

  it('dates outside the selected period are left as saved; coming off IR keeps your edited days', () => {
    let st = start();
    st = save(st, '2026-11-19', moveOptions(days(st).get('2026-11-19')!, 'mcdavid', roster(st), seats).find((o) => o.seatLabel === 'Bench')!.next);
    const outside = planIrChange('matthews', true, roster(st), ['2026-11-17'], seats, s, st.manual);
    expect(Object.keys(outside.manual)).toEqual([]);
    st = reducer(st, { type: 'applyIrChange', id: 'mcdavid', onIr: true, manual: planIrChange('mcdavid', true, roster(st), DATES, seats, s, st.manual).manual });
    const saved = st.manual['2026-11-19'];
    const back = planIrChange('mcdavid', false, roster(st), DATES, seats, s, st.manual);
    expect(back.manual).toEqual({});
    st = reducer(st, { type: 'applyIrChange', id: 'mcdavid', onIr: false, manual: back.manual });
    expect(st.manual['2026-11-19']).toEqual(saved);
    // Automatic days pick him up again.
    expect(days(st).get('2026-11-17')!.players.find((x) => x.playerId === 'mcdavid')!.seatKey).toBeDefined();
  });
});

describe('replacing a starter from the bench (both directions)', () => {
  // Two D seats; three defensemen who all play on Dec 2.
  const ds = sched([['2026-12-02', 'ANA', 'COL'], ['2026-12-02', 'SJS', 'VGK']]);
  const D = (id: string, team: string): Player => ({ id, name: id, team, positions: ['D'], eligibilitySource: 'nhl' });
  const dir = new Map([D('zadorov', 'ANA'), D('makar', 'COL'), D('luneau', 'SJS')].map((p) => [p.id, p]));
  const dLeague = { rosterSize: 22, irSlots: 2, slots: slots({ D: [2, ['D']] }) };
  const dSeats = expandSeats(dLeague.slots);
  const r = (st: AppState) => toLineupPlayers(st.roster, dir);
  const day = (st: AppState) => optimizeDates(['2026-12-02'], r(st), st.league, ds, st.manual).get('2026-12-02')!;
  const put = (st: AppState, next: Record<string, string | null>) => reducer(st, { type: 'setManual', date: '2026-12-02', override: overrideFor('2026-12-02', next, r(st), dSeats, ds) });

  it('Luneau/Zadorov: after Luneau replaces Zadorov, selecting Luneau offers Zadorov back, with the games gained and given up', () => {
    let st = reducer({ ...initialState(), league: dLeague }, { type: 'addPlayers', ids: ['zadorov', 'makar', 'luneau'] });
    expect(day(st).players.find((x) => x.playerId === 'luneau')!.seatKey).toBeUndefined(); // Luneau sits (last in roster order)
    const swapIn = addOptions(day(st), 'luneau', r(st), dSeats).find((o) => o.outId === 'zadorov')!;
    st = put(st, swapIn.next);
    expect(day(st).players.find((x) => x.playerId === 'zadorov')!.seatKey).toBeUndefined();
    // From Luneau's row: Zadorov is a replacement, net 0 (one game for another).
    const back = replaceOptions(day(st), 'luneau', r(st), dSeats);
    const z = back.find((o) => o.inId === 'zadorov')!;
    expect(z).toMatchObject({ net: 0 });
    expect(z.gain).toBe(day(st).players.find((x) => x.playerId === 'zadorov')!.game);
    expect(z.lose).toBe(day(st).players.find((x) => x.playerId === 'luneau')!.game);
    expect(z.next[z.seatKey]).toBe('zadorov');
    st = put(st, z.next);
    expect(st.manual).toEqual({}); // reversed: back to the automatic lineup
  });

  it('replacements never include IR or seated players, and put players with a game first', () => {
    let st = reducer({ ...initialState(), league: dLeague }, { type: 'addPlayers', ids: ['zadorov', 'makar', 'luneau'] });
    st = reducer(st, { type: 'updateEntry', id: 'luneau', patch: { onIr: true } });
    expect(replaceOptions(day(st), 'zadorov', r(st), dSeats)).toEqual([]);
  });
});

describe('period overview', () => {
  it('per-day figures match the day results; open spots only on edited days', () => {
    let st = start();
    const summaries = () => summarizeDays([...days(st).values()], roster(st), seats);
    for (const sm of summaries()) {
      const d = days(st).get(sm.date)!;
      expect(sm).toMatchObject({ usable: d.usable, scheduled: d.scheduled, optimal: d.optimalUsable, manual: false, opportunities: [] });
    }
    st = save(st, '2026-11-17', moveOptions(days(st).get('2026-11-17')!, 'mcdavid', roster(st), seats).find((o) => o.seatLabel === 'Bench')!.next);
    const nov17 = summaries().find((x) => x.date === '2026-11-17')!;
    expect(nov17.manual).toBe(true);
    expect(nov17.opportunities).toContain('mcdavid');
    expect(summaries().filter((x) => x.date !== '2026-11-17').every((x) => x.opportunities.length === 0)).toBe(true);
  });
});
