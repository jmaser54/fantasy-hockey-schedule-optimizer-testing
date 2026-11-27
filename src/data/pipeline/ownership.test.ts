import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNERSHIP_VERSION, type OwnershipFile, type PlayersFile } from '../format.ts';
import { buildOwnershipData, isOnCurrentNhlRoster, isOwnershipStale, loadOwnership, OWNERSHIP_STALE_AFTER_MS, ownershipForRanking } from '../load.ts';
import { validateOwnership } from '../validate.ts';
import { parseEspnPlayers, type EspnPlayer } from './espn.ts';
import { buildOwnership, ESPN_ID_OVERRIDES, ownershipUpdateProblems } from './ownership.ts';

type DirPlayer = PlayersFile['players'][number];
const dir = (nhlId: number, name: string, team: string, extra: Partial<DirPlayer> = {}): DirPlayer => ({
  id: `nhl-${nhlId}`,
  name,
  team,
  positions: ['C'],
  eligibilitySource: 'espn',
  nhlId,
  ...extra,
});
const espn = (espnId: number, name: string, proTeamId: number, percentOwned?: number): EspnPlayer => ({
  espnId,
  name,
  proTeamId,
  defaultPositionId: 1,
  eligibleSlots: [0],
  ...(percentOwned !== undefined ? { percentOwned } : {}),
});

// ESPN proTeamIds for the fixture's teams.
const PRO: Record<string, number> = { NYR: 13, SEA: 30, DET: 5, MTL: 10, BOS: 1 };
/** 10 current players per team, each already linked to ESPN by the directory, with varied ownership (incl. 0). */
function fixture() {
  const players: DirPlayer[] = [];
  const records: EspnPlayer[] = [];
  let n = 0;
  for (const [team, pro] of Object.entries(PRO)) {
    for (let i = 0; i < 10; i++, n++) {
      players.push(dir(9000000 + n, `Player ${n}`, team, { espnId: 7000000 + n }));
      records.push(espn(7000000 + n, `Player ${n}`, pro, n % 7 === 0 ? 0 : (n * 3.17) % 100));
    }
  }
  // The four nickname cases: on NHL rosters, no ESPN id in the directory; ESPN has them under a short name.
  players.push(dir(8480813, 'Joseph Veleno', 'NYR'), dir(8479372, 'Josh Mahura', 'SEA'), dir(8478470, 'Samuel Montembeault', 'DET'), dir(8482737, 'Zachary Bolduc', 'MTL'));
  records.push(espn(4352804, 'Joe Veleno', PRO.NYR!, 0.12), espn(4063504, 'Joshua Mahura', PRO.SEA!, 0.06), espn(3942714, 'Sam Montembeault', PRO.DET!, 0.91), espn(4874734, 'Zack Bolduc', PRO.MTL!, 5.5));
  // NHL players with no ESPN record at all.
  players.push(dir(8485010, 'Gregor Biber', 'BOS'), dir(8482922, 'Kirill Kirsanov', 'BOS'), dir(8485594, 'Yegor Borikov', 'BOS'));
  // ESPN-only directory record (minors): not an NHL player, never in ownership.
  players.push({ id: 'espn-5555', name: 'Minor Leaguer', team: 'BOS', positions: ['D'], eligibilitySource: 'espn', espnId: 5555, inactive: true });
  records.push(espn(5555, 'Minor Leaguer', PRO.BOS!, 0.01));
  return { players, records };
}
const ids = (players: DirPlayer[]) => new Set(players.map((p) => p.id));

describe('ESPN ownership parsing', () => {
  it('keeps percentages from 0 to 100 and leaves anything else unknown (never 0)', () => {
    const raw = [0, 100, 55.25, null, '5', -1, 100.01, Number.NaN, undefined].map((v, i) => ({
      id: i + 1,
      fullName: `P${i}`,
      proTeamId: 1,
      defaultPositionId: 1,
      eligibleSlots: [0],
      ownership: v === undefined ? undefined : { percentOwned: v },
    }));
    raw.push({ id: 99, fullName: 'No ownership object', proTeamId: 1, defaultPositionId: 1, eligibleSlots: [0], ownership: 'n/a' as never });
    const parsed = parseEspnPlayers(raw);
    expect(parsed.map((p) => p.percentOwned)).toEqual([0, 100, 55.25, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect('percentOwned' in parsed[3]!).toBe(false);
  });
});

describe('buildOwnership', () => {
  it('stores ownership by NHL player id, keeps 0%, and leaves invalid or missing ownership unknown', () => {
    const { players, records } = fixture();
    records.find((r) => r.espnId === 7000003)!.percentOwned = undefined; // invalid upstream → unknown
    const b = buildOwnership({ players, espn: records, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z' });
    expect(b.file).toMatchObject({ version: OWNERSHIP_VERSION, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z' });
    expect(b.file.players['nhl-9000000']).toEqual({ espnId: 7000000, pct: 0 });
    expect(b.file.players['nhl-9000003']).toBeUndefined();
    expect(Object.keys(b.file.players).every((k) => /^nhl-\d+$/.test(k))).toBe(true);
    expect(Object.values(b.file.players).some((e) => e.espnId === 5555)).toBe(false); // ESPN-only record excluded
  });

  it('applies the four hand-checked ESPN id links when the record exists and the team matches', () => {
    expect([...ESPN_ID_OVERRIDES]).toEqual([
      [8480813, 4352804],
      [8479372, 4063504],
      [8478470, 3942714],
      [8482737, 4874734],
    ]);
    const { players, records } = fixture();
    const b = buildOwnership({ players, espn: records, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z' });
    expect(b.stats.overridesApplied).toBe(4);
    expect(b.file.players['nhl-8480813']).toEqual({ espnId: 4352804, pct: 0.12 });
    expect(b.file.players['nhl-8478470']).toEqual({ espnId: 3942714, pct: 0.91 });
    expect(b.warnings).toEqual([]);
  });

  it('ignores a link whose ESPN record is missing, on another team, or already taken', () => {
    const { players, records } = fixture();
    const without = records.filter((r) => r.espnId !== 4352804); // Joe Veleno not in the response
    without.find((r) => r.espnId === 4063504)!.proTeamId = PRO.BOS!; // Mahura listed on another team
    players.find((p) => p.nhlId === 9000001)!.espnId = 3942714; // Montembeault's ESPN id already belongs to someone
    const b = buildOwnership({ players, espn: without, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z' });
    expect(b.stats.overridesApplied).toBe(1); // only Bolduc
    expect(b.file.players['nhl-8480813']).toBeUndefined();
    expect(b.file.players['nhl-8479372']).toBeUndefined();
    expect(b.file.players['nhl-8478470']).toBeUndefined();
    expect(b.warnings.join('\n')).toMatch(/no such ESPN record[\s\S]*ESPN team BOS ≠ SEA|ESPN team BOS ≠ SEA[\s\S]*no such ESPN record/);
    expect(b.warnings.join('\n')).toMatch(/already belongs to another player/);
  });

  it('keeps NHL players with no ESPN record as players with unknown ownership', () => {
    const { players, records } = fixture();
    const b = buildOwnership({ players, espn: records, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z' });
    for (const id of ['nhl-8485010', 'nhl-8482922', 'nhl-8485594']) expect(b.file.players[id]).toBeUndefined();
    expect(b.stats.currentPlayers).toBe(57); // they still count as current NHL players
    expect(b.stats.currentWithOwnership).toBe(54);
  });
});

describe('ownership update safeguards', () => {
  const build = (mutate?: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture();
    mutate?.(f);
    return { b: buildOwnership({ players: f.players, espn: f.records, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z' }), f };
  };

  it('accepts a normal refresh', () => {
    const { b, f } = build();
    expect(ownershipUpdateProblems(b, undefined, ids(f.players))).toEqual([]);
  });

  it('refuses an incomplete response (too few current NHL players matched)', () => {
    const { b, f } = build((x) => {
      x.records.splice(0, 20); // ESPN returned a partial list
    });
    expect(ownershipUpdateProblems(b, undefined, ids(f.players)).join()).toMatch(/current NHL players have ownership/);
  });

  it('refuses a response with too many invalid percentages', () => {
    const { b, f } = build((x) => {
      for (const r of x.records.slice(0, 3)) delete r.percentOwned;
    });
    expect(ownershipUpdateProblems(b, undefined, ids(f.players)).join()).toMatch(/no valid ownership percentage/);
  });

  it('refuses a sharp fall versus the previous file of the same season, but not across seasons', () => {
    const { b, f } = build();
    const bigger: OwnershipFile = { ...b.file, players: { ...b.file.players } };
    for (let i = 0; i < 20; i++) bigger.players[`nhl-${100 + i}`] = { espnId: 100 + i, pct: 1 };
    expect(ownershipUpdateProblems(b, bigger, ids(f.players)).join()).toMatch(/entries fell/);
    expect(ownershipUpdateProblems(b, { ...bigger, season: '20252026' }, ids(f.players))).toEqual([]);
  });
});

describe('validateOwnership', () => {
  const ok = { version: OWNERSHIP_VERSION, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z', source: 'x', players: { 'nhl-1': { espnId: 10, pct: 0 }, 'nhl-2': { espnId: 11, pct: 100 } } };
  it('accepts 0 and 100 and rejects bad values, keys, duplicates and seasons', () => {
    expect(validateOwnership(ok, { season: '20262027' }).errors).toEqual([]);
    expect(validateOwnership({ ...ok, players: { 'nhl-1': { espnId: 10, pct: 100.5 } } }).errors.join()).toMatch(/invalid percentage/);
    expect(validateOwnership({ ...ok, players: { 'nhl-1': { espnId: 10, pct: null } } }).errors.join()).toMatch(/invalid percentage/);
    expect(validateOwnership({ ...ok, players: { 'espn-1': { espnId: 10, pct: 5 } } }).errors.join()).toMatch(/not an NHL player id/);
    expect(validateOwnership({ ...ok, players: { 'nhl-1': { espnId: 10, pct: 5 }, 'nhl-2': { espnId: 10, pct: 6 } } }).errors.join()).toMatch(/appears twice/);
    expect(validateOwnership(ok, { season: '20272028' }).errors.join()).toMatch(/expected 20272028/);
    expect(validateOwnership(ok, { playerIds: new Set(['nhl-1']) }).warnings.join()).toMatch(/1 ownership entries are not in the player directory/);
  });
});

describe('ownership loading, freshness and eligibility', () => {
  const raw = { version: OWNERSHIP_VERSION, season: '20262027', fetchedAt: '2026-11-27T12:00:00Z', source: 'x', players: { 'nhl-1': { espnId: 10, pct: 0 } } };
  afterEach(() => vi.unstubAllGlobals());

  it('loads valid ownership and gives nothing for invalid files or another season', () => {
    expect(buildOwnershipData(raw, '20262027')?.byPlayerId.get('nhl-1')).toEqual({ espnId: 10, pct: 0 });
    expect(buildOwnershipData({ ...raw, players: { 'nhl-1': { espnId: 10, pct: -1 } } }, '20262027')).toBeUndefined();
    expect(buildOwnershipData('not json', '20262027')).toBeUndefined();
    expect(buildOwnershipData(raw, '20272028')).toBeUndefined();
  });

  it('keeps the app working when the file is missing or unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await expect(loadOwnership('20262027', '/')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    await expect(loadOwnership('20262027', '/')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })));
    expect((await loadOwnership('20262027', '/'))?.byPlayerId.size).toBe(1);
  });

  it('treats ownership older than 48 hours as stale and unusable for ranking', () => {
    const o = buildOwnershipData(raw, '20262027')!;
    const t = Date.parse(raw.fetchedAt);
    expect(OWNERSHIP_STALE_AFTER_MS).toBe(48 * 3_600_000);
    expect(isOwnershipStale(o, t + OWNERSHIP_STALE_AFTER_MS)).toBe(false);
    expect(isOwnershipStale(o, t + OWNERSHIP_STALE_AFTER_MS + 1)).toBe(true);
    expect(ownershipForRanking(o, t + 3_600_000)).toBe(o);
    expect(ownershipForRanking(o, t + OWNERSHIP_STALE_AFTER_MS + 1)).toBeUndefined();
    expect(ownershipForRanking(undefined)).toBeUndefined();
  });

  it('counts only players on a current NHL roster as Insights candidates', () => {
    expect(isOnCurrentNhlRoster({ nhlId: 1 })).toBe(true); // on the roster, injured or not
    expect(isOnCurrentNhlRoster({ nhlId: 1, inactive: true })).toBe(false); // dropped off the current-roster feed
    expect(isOnCurrentNhlRoster({ inactive: true })).toBe(false); // ESPN-only record
    expect(isOnCurrentNhlRoster({})).toBe(false); // custom player
  });
});
