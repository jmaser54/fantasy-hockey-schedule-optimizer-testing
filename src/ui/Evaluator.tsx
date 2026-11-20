import { useEffect, useMemo, useState } from 'react';
import type { SkaterPositionCode, SkaterStatLine, SkaterStatsFile } from '../data/format.ts';
import { evaluateSavedRoster, loadSkaterStats } from '../data/evaluatorData.ts';
import { STALE_AFTER_MS } from '../data/load.ts';
import { formatShort } from '../domain/dates.ts';
import {
  isScaledStat,
  RANKING_STATS,
  rankPlayers,
  SEASON_GAMES,
  STAT_DEFINITIONS,
  type Benchmark,
  type BenchmarkChoice,
  type EvaluatedSubject,
  type StatKey,
} from '../domain/evaluator.ts';
import type { Player } from '../domain/types.ts';
import { loadEvaluatorPrefs, saveEvaluatorPrefs, type EvaluatorPrefs } from '../state/evaluatorPrefs.ts';
import { useApp } from './context.ts';
import { InfoTip } from './common.tsx';
import { formatAdjusted, formatStat, POSITION_SHORT, searchSkaters, STAT_GROUPS, STAT_SHORT, type StatGroupId } from './evaluatorFormat.ts';

/**
 * Player Evaluator (first functional prototype). Reads the saved roster, never changes it, and keeps
 * its own preferences (comparison players, benchmark, rankings minimum GP) in a separate storage key.
 * The stats snapshot is fetched only when this tab is opened, once per page load.
 */

type StatsStatus = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; file: SkaterStatsFile };

let statsRequest: Promise<SkaterStatsFile> | null = null;
function requestStats(season: string): Promise<SkaterStatsFile> {
  statsRequest ??= loadSkaterStats(undefined, { season }).catch((err: unknown) => {
    statsRequest = null; // allow a retry
    throw err;
  });
  return statsRequest;
}

const LABEL = new Map(STAT_DEFINITIONS.map((d) => [d.key, d.label]));
const isPhone = () => globalThis.matchMedia?.('(max-width: 600px)').matches ?? false;

export function EvaluatorView({ onGoRoster }: { onGoRoster: () => void }) {
  const { data } = useApp();
  const [status, setStatus] = useState<StatsStatus>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setStatus({ state: 'loading' });
    requestStats(data.season)
      .then((file) => live && setStatus({ state: 'ready', file }))
      .catch((err: Error) => live && setStatus({ state: 'error', message: err.message }));
    return () => {
      live = false;
    };
  }, [data.season, attempt]);

  if (status.state === 'loading') return <div className="empty">Loading NHL player stats…</div>;
  if (status.state === 'error')
    return (
      <div className="notice error">
        <b>Player stats couldn’t be loaded.</b> The rest of Playoff Planner still works. <span className="muted small">{status.message}</span>{' '}
        <button className="btn small" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </button>
      </div>
    );
  return <Evaluator file={status.file} onGoRoster={onGoRoster} />;
}

function Evaluator({ file, onGoRoster }: { file: SkaterStatsFile; onGoRoster: () => void }) {
  const { state, data } = useApp();
  const [prefs, setPrefs] = useState<EvaluatorPrefs>(loadEvaluatorPrefs);
  const [view, setView] = useState<'roster' | 'rankings'>('roster');
  useEffect(() => {
    saveEvaluatorPrefs(prefs);
  }, [prefs]);

  const result = useMemo(() => evaluateSavedRoster(state, data.players, file, prefs), [state, data.players, file, prefs]);
  const directoryByNhlId = useMemo(() => {
    const m = new Map<number, Player>();
    for (const p of data.players) if (p.nhlId !== undefined) m.set(p.nhlId, p);
    return m;
  }, [data.players]);
  const teamOf = (nhlId: number | undefined, line?: SkaterStatLine) => (nhlId !== undefined ? directoryByNhlId.get(nhlId)?.team : undefined) ?? line?.teams.join('/') ?? '';

  const fetched = Date.parse(file.fetchedAt);
  const stale = Number.isNaN(fetched) || Date.now() - fetched > STALE_AFTER_MS;
  const when = formatShort(file.fetchedAt.slice(0, 10));

  const setBenchmark = (benchmark: BenchmarkChoice) => setPrefs((p) => ({ ...p, benchmark }));
  const removeComparison = (id: number) =>
    setPrefs((p) => ({
      ...p,
      comparisons: p.comparisons.filter((x) => x !== id),
      benchmark: p.benchmark.kind === 'player' && p.benchmark.nhlId === id ? { kind: 'roster-max' } : p.benchmark,
    }));
  const addComparison = (id: number) => setPrefs((p) => (p.comparisons.includes(id) ? p : { ...p, comparisons: [...p.comparisons, id] }));

  return (
    <div className="stack evaluator">
      <div className="eval-head">
        <div>
          <h2 className="eval-title">{view === 'roster' ? 'Player Evaluator' : 'League Rankings'}</h2>
          <p className="eval-sub">
            {view === 'roster'
              ? 'Your skaters’ production, normalized to the same number of games.'
              : 'Every NHL skater, ranked on one stat normalized to your benchmark.'}
          </p>
        </div>
        <span className={stale ? 'badge warn' : 'small muted'} title={`NHL regular-season stats, fetched ${file.fetchedAt.replace('T', ' ').slice(0, 16)} UTC`}>
          {stale ? `Stats from ${when}, may be outdated` : `NHL stats updated ${when}`}
        </span>
      </div>

      <BenchmarkBar benchmark={result.evaluation.benchmark} choice={prefs.benchmark} comparisons={result.evaluation.comparisons} onChange={setBenchmark} />

      {view === 'roster' ? (
        <>
          <RosterPanel
            roster={result.evaluation.roster}
            comparisons={result.evaluation.comparisons}
            benchmark={result.evaluation.benchmark}
            teamOf={teamOf}
            onRemoveComparison={removeComparison}
            emptyRoster={state.roster.length === 0}
            onGoRoster={onGoRoster}
            goalies={result.evaluation.goalies.map((g) => g.name)}
            footer={<ComparisonSearch skaters={file.skaters} exclude={new Set([...result.rosterNhlIds, ...prefs.comparisons])} teamOf={teamOf} onAdd={addComparison} />}
          />
          <button type="button" className="rankings-link" onClick={() => setView('rankings')}>
            League rankings <span aria-hidden="true">→</span>
            <span className="muted small">Rank every NHL skater on one stat</span>
          </button>
        </>
      ) : (
        <>
          <button type="button" className="link-btn back-link" onClick={() => setView('roster')}>
            ← Back to your roster
          </button>
          <RankingsPanel
            skaters={file.skaters}
            benchmark={result.evaluation.benchmark}
            rosterNhlIds={result.rosterNhlIds}
            minGamesPlayed={prefs.minGamesPlayed}
            onMinGamesPlayed={(minGamesPlayed) => setPrefs((p) => ({ ...p, minGamesPlayed }))}
            teamOf={teamOf}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Benchmark

function benchmarkSource(b: Benchmark): string {
  if (!b.available) return '';
  switch (b.basis) {
    case 'roster-max':
      return `Most games on your roster${b.name ? ` (${b.name})` : ''}`;
    case 'league-max':
      return 'Most games in the NHL (none of your skaters have stats yet)';
    case 'player':
      return `${b.name ?? 'Comparison player'}’s games played`;
    case 'custom':
      return 'Custom';
  }
}

function BenchmarkBar(props: { benchmark: Benchmark; choice: BenchmarkChoice; comparisons: EvaluatedSubject[]; onChange: (c: BenchmarkChoice) => void }) {
  const { benchmark, choice, onChange } = props;
  const [draft, setDraft] = useState(choice.kind === 'custom' ? String(choice.gamesPlayed) : '');
  useEffect(() => {
    if (choice.kind === 'custom') setDraft(String(choice.gamesPlayed));
  }, [choice]);
  const players = props.comparisons.filter((c) => c.status === 'ok' && c.nhlId !== undefined);
  const value = choice.kind === 'player' ? `p:${choice.nhlId}` : choice.kind;
  const draftNum = Number(draft);
  const draftValid = /^\d+$/.test(draft) && draftNum >= 1 && draftNum <= SEASON_GAMES;

  const select = (v: string) => {
    if (v === 'roster-max') onChange({ kind: 'roster-max' });
    else if (v === 'custom') onChange({ kind: 'custom', gamesPlayed: benchmark.available ? benchmark.gamesPlayed : SEASON_GAMES });
    else onChange({ kind: 'player', nhlId: Number(v.slice(2)) });
  };

  return (
    <div className="panel bench">
      <div className="bench-main">
        <div className="bench-value">
          {benchmark.available ? (
            <>
              Normalized to <b>{benchmark.gamesPlayed} GP</b>
            </>
          ) : (
            <b>No benchmark</b>
          )}
          <InfoTip label="How normalization works">
            <span>
              Counting stats are shown as if every player had played the same number of games: <b>stat ÷ GP × benchmark</b>. Actual totals stay visible.
            </span>
            <span>+/-, S%, FO% and TOI are shown as reported.</span>
            <span>This compares observed production. It isn’t a projection.</span>
          </InfoTip>
        </div>
        <div className="small muted">{benchmark.available ? benchmarkSource(benchmark) : 'Choose a benchmark to see normalized stats.'}</div>
      </div>
      <div className="bench-controls">
        <label className="small muted" htmlFor="bench-select">
          Benchmark
        </label>
        <select id="bench-select" value={value} onChange={(e) => select(e.target.value)}>
          <option value="roster-max">Roster max</option>
          {players.map((p) => (
            <option key={p.nhlId} value={`p:${p.nhlId}`}>
              {p.name} ({p.stats!.gamesPlayed} GP)
            </option>
          ))}
          {choice.kind === 'player' && !players.some((p) => p.nhlId === choice.nhlId) && <option value={value}>Comparison player</option>}
          <option value="custom">Custom…</option>
        </select>
        {choice.kind === 'custom' && (
          <span className="bench-custom">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={SEASON_GAMES}
              step={1}
              aria-label="Custom benchmark games played"
              aria-invalid={!draftValid}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (/^\d+$/.test(e.target.value) && n >= 1 && n <= SEASON_GAMES) onChange({ kind: 'custom', gamesPlayed: n });
              }}
            />
            <span className="small muted">GP</span>
            {!draftValid && <span className="badge bad">1–{SEASON_GAMES}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster evaluation

const REASON: Record<string, string> = {
  'no-games': 'No NHL games yet this season',
  unmatched: 'Not linked to an NHL player, so no stats',
  'unknown-player': 'Not found in the current player data',
};

type SortState = { key: StatKey; dir: 'desc' | 'asc' } | null;

function statValue(s: EvaluatedSubject, key: StatKey): number | null {
  if (!s.stats) return null;
  if (isScaledStat(key)) return s.adjusted ? s.adjusted[key] : null;
  return s.stats[key];
}

function sortRows(rows: EvaluatedSubject[], sort: SortState): EvaluatedSubject[] {
  if (!sort) return rows;
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = statValue(a, sort.key);
    const y = statValue(b, sort.key);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return sign * (x - y);
  });
}

function RosterPanel(props: {
  roster: EvaluatedSubject[];
  comparisons: EvaluatedSubject[];
  benchmark: Benchmark;
  teamOf: (nhlId: number | undefined, line?: SkaterStatLine) => string;
  onRemoveComparison: (id: number) => void;
  emptyRoster: boolean;
  onGoRoster: () => void;
  goalies: string[];
  footer: React.ReactNode;
}) {
  const [group, setGroup] = useState<StatGroupId>(() => (isPhone() ? 'scoring' : 'all'));
  const [sort, setSort] = useState<SortState>(null);
  const stats = STAT_GROUPS.find((g) => g.id === group)!.stats;
  const cols = stats.length + 2;
  const onSort = (key: StatKey) => setSort((s) => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' }));
  const ok = (rows: EvaluatedSubject[]) => rows.filter((r) => r.status === 'ok');
  const missing = props.roster.filter((r) => r.status !== 'ok');

  const row = (s: EvaluatedSubject, kind: 'roster' | 'comparison') => (
    <tr key={`${kind}-${s.playerId ?? s.nhlId}`} className={kind === 'comparison' ? 'cmp-row' : undefined}>
      <th scope="row" className="sticky">
        <span className="ev-name">
          {kind === 'roster' && <span className="mine-dot" title="On your roster" />}
          <span>{s.name}</span>
          {s.onIr && <span className="badge">IR</span>}
          {kind === 'comparison' && s.nhlId !== undefined && (
            <button className="icon-btn ev-remove" aria-label={`Remove ${s.name} from comparison`} title="Remove from comparison" onClick={() => props.onRemoveComparison(s.nhlId!)}>
              ✕
            </button>
          )}
        </span>
        <span className="ev-meta">
          {s.stats ? `${POSITION_SHORT[s.stats.position]} · ` : ''}
          {props.teamOf(s.nhlId, s.stats)}
        </span>
      </th>
      {s.status === 'ok' && s.stats ? (
        <>
          <td className="n">{s.stats.gamesPlayed}</td>
          {stats.map((k) => (
            <StatCell key={k} subject={s} stat={k} />
          ))}
        </>
      ) : (
        <td colSpan={cols - 1} className="ev-reason">
          {REASON[s.status] ?? 'No stats'}
        </td>
      )}
    </tr>
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Your roster</h2>
        <div className="segmented" role="group" aria-label="Stat group">
          {STAT_GROUPS.map((g) => (
            <button key={g.id} aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
      </div>
      {props.emptyRoster ? (
        <div className="empty">
          <strong>No roster yet</strong>
          Add your players on the{' '}
          <button className="link-btn" onClick={props.onGoRoster}>
            Roster tab
          </button>{' '}
          and they’ll appear here automatically.
        </div>
      ) : null}
      {(!props.emptyRoster || props.comparisons.length > 0) && (
        <div className="table-wrap">
          <table className="eval-table">
            <thead>
              <tr>
                <th className="sticky">Player</th>
                <th className="n" title="Games played (actual)">
                  GP
                </th>
                {stats.map((k) => (
                  <th
                    key={k}
                    className={`n sortable${sort?.key === k ? ' active' : ''}`}
                    title={`${LABEL.get(k)}${isScaledStat(k) ? ' — normalized, actual below' : ' — as reported'}. Click to sort.`}
                    aria-sort={sort?.key === k ? (sort.dir === 'desc' ? 'descending' : 'ascending') : undefined}
                    onClick={() => onSort(k)}
                  >
                    {STAT_SHORT[k]}
                    {sort?.key === k ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortRows(ok(props.roster), sort).map((s) => row(s, 'roster'))}
              {missing.map((s) => row(s, 'roster'))}
              {props.comparisons.length > 0 && (
                <tr className="group-row">
                  <td colSpan={cols}>Comparison players · not on your roster</td>
                </tr>
              )}
              {sortRows(ok(props.comparisons), sort).map((s) => row(s, 'comparison'))}
              {props.comparisons.filter((c) => c.status !== 'ok').map((s) => row(s, 'comparison'))}
            </tbody>
          </table>
        </div>
      )}
      <div className="eval-foot">
        {props.footer}
        <p className="small muted ev-legend">
          <b className="num">12.3</b> normalized to {props.benchmark.available ? `${props.benchmark.gamesPlayed} GP` : 'the benchmark'} · <span className="num">10</span> actual
          {props.goalies.length > 0 && (
            <>
              <br />
              Goalies aren’t evaluated yet: {props.goalies.join(', ')}.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function StatCell({ subject, stat }: { subject: EvaluatedSubject; stat: StatKey }) {
  const s = subject.stats!;
  if (!isScaledStat(stat)) return <td className="n">{formatStat(stat, s[stat])}</td>;
  const adj = subject.adjusted?.[stat];
  return (
    <td className="n ev-cell" title={adj !== undefined ? `${LABEL.get(stat)}: ${s[stat]} in ${s.gamesPlayed} GP → ${adj.toFixed(3)}` : undefined}>
      <b>{adj !== undefined ? formatAdjusted(adj) : '—'}</b>
      <span className="ev-actual">{s[stat]}</span>
    </td>
  );
}

function ComparisonSearch(props: { skaters: readonly SkaterStatLine[]; exclude: ReadonlySet<number>; teamOf: (id: number, line?: SkaterStatLine) => string; onAdd: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchSkaters(q, props.skaters, props.exclude), [q, props.skaters, props.exclude]);
  const pick = (s: SkaterStatLine | undefined) => {
    if (!s) return;
    props.onAdd(s.nhlId);
    setQ('');
    setActive(0);
  };
  return (
    <div className="search ev-search">
      <input
        value={q}
        placeholder="Compare an NHL skater…"
        aria-label="Add a comparison player"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter') pick(results[active]);
          else if (e.key === 'Escape') setOpen(false);
          else return;
          e.preventDefault();
        }}
      />
      {open && q.trim().length >= 2 && (
        <ul className="suggest" role="listbox">
          {results.length === 0 && <li className="muted">No skaters with stats match “{q}”</li>}
          {results.map((s, i) => (
            <li key={s.nhlId} role="option" aria-selected={i === active} onMouseDown={(e) => (e.preventDefault(), pick(s))} onMouseEnter={() => setActive(i)}>
              <span>{s.name}</span>
              <span className="pos">{POSITION_SHORT[s.position]}</span>
              <span className="meta">
                {props.teamOf(s.nhlId, s)} · {s.gamesPlayed} GP
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// League-wide rankings (secondary)

const PAGE = 50;
const POSITION_FILTERS: { id: 'all' | SkaterPositionCode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'C', label: 'C' },
  { id: 'L', label: 'LW' },
  { id: 'R', label: 'RW' },
  { id: 'D', label: 'D' },
];

function RankingsPanel(props: {
  skaters: readonly SkaterStatLine[];
  benchmark: Benchmark;
  rosterNhlIds: ReadonlySet<number>;
  minGamesPlayed: number;
  onMinGamesPlayed: (n: number) => void;
  teamOf: (nhlId: number, line?: SkaterStatLine) => string;
}) {
  const [stat, setStat] = useState<StatKey>('points');
  const [position, setPosition] = useState<'all' | SkaterPositionCode>('all');
  const [direction, setDirection] = useState<'desc' | 'asc'>('desc');
  const [shown, setShown] = useState(PAGE);
  const [minDraft, setMinDraft] = useState(String(props.minGamesPlayed));
  const minValid = /^\d+$/.test(minDraft) && Number(minDraft) >= 1 && Number(minDraft) <= SEASON_GAMES;
  const scaled = isScaledStat(stat);
  const bm = props.benchmark;
  const canRank = !scaled || bm.available;

  const rows = useMemo(
    () =>
      canRank
        ? rankPlayers(props.skaters, {
            stat,
            benchmarkGp: bm.available ? bm.gamesPlayed : undefined,
            rosterNhlIds: props.rosterNhlIds,
            minGamesPlayed: props.minGamesPlayed,
            positions: position === 'all' ? undefined : [position],
            direction,
          })
        : [],
    [canRank, props.skaters, stat, bm, props.rosterNhlIds, props.minGamesPlayed, position, direction],
  );
  useEffect(() => setShown(PAGE), [stat, position, direction, props.minGamesPlayed]);
  const mine = rows.filter((r) => r.onRoster).length;

  return (
    <div className="panel">
      <div className="panel-body rank-controls">
        <label className="field">
          <span className="small muted">Stat</span>
          <select value={stat} onChange={(e) => setStat(e.target.value as StatKey)}>
            {RANKING_STATS.map((k) => (
              <option key={k} value={k}>
                {LABEL.get(k)} ({STAT_SHORT[k]})
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="small muted">Position</span>
          <div className="segmented" role="group" aria-label="Position">
            {POSITION_FILTERS.map((p) => (
              <button key={p.id} aria-pressed={position === p.id} onClick={() => setPosition(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field min-gp">
          <span className="small muted">Min GP</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={SEASON_GAMES}
            step={1}
            aria-invalid={!minValid}
            value={minDraft}
            onChange={(e) => {
              setMinDraft(e.target.value);
              const n = Number(e.target.value);
              if (/^\d+$/.test(e.target.value) && n >= 1 && n <= SEASON_GAMES) props.onMinGamesPlayed(n);
            }}
          />
        </label>
        <div className="field">
          <span className="small muted">Order</span>
          <div className="segmented" role="group" aria-label="Order">
            <button aria-pressed={direction === 'desc'} onClick={() => setDirection('desc')}>
              Highest
            </button>
            <button aria-pressed={direction === 'asc'} onClick={() => setDirection('asc')}>
              Lowest
            </button>
          </div>
        </div>
      </div>
      {!canRank ? (
        <div className="empty">Choose a benchmark above to rank on {LABEL.get(stat)?.toLowerCase()}.</div>
      ) : (
        <>
          <p className="small muted rank-summary">
            {rows.length} skaters with {props.minGamesPlayed}+ GP
            {mine > 0 && (
              <>
                {' '}
                · <span className="mine-dot" /> {mine} on your roster
              </>
            )}
            {' · '}
            {scaled ? `normalized to ${bm.available ? bm.gamesPlayed : ''} GP, actual below` : 'as reported'}
            {!minValid && <span className="badge bad"> Min GP 1–{SEASON_GAMES}</span>}
          </p>
          <div className="table-wrap">
            <table className="eval-table rank-table">
              <thead>
                <tr>
                  <th className="n">#</th>
                  <th className="sticky">Player</th>
                  <th className="n">GP</th>
                  <th className="n">{STAT_SHORT[stat]}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r) => (
                  <tr key={r.nhlId} className={r.onRoster ? 'mine' : undefined}>
                    <td className="n muted">{r.rank ?? '—'}</td>
                    <th scope="row" className="sticky">
                      <span className="ev-name">
                        {r.onRoster && <span className="mine-dot" title="On your roster" />}
                        <span>{r.name}</span>
                      </span>
                      <span className="ev-meta">
                        {POSITION_SHORT[r.position]} · {props.teamOf(r.nhlId, { teams: r.teams } as SkaterStatLine)}
                      </span>
                    </th>
                    <td className="n">{r.gamesPlayed}</td>
                    {scaled ? (
                      <td className="n ev-cell">
                        <b>{r.value !== null ? formatAdjusted(r.value) : '—'}</b>
                        <span className="ev-actual">{r.actual ?? '—'}</span>
                      </td>
                    ) : (
                      <td className="n">{formatStat(stat, r.value)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <div className="empty">No skaters match these filters.</div>}
          {rows.length > shown && (
            <div className="rank-more">
              <button className="btn small" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
