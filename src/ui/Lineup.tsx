import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatShort, weekday } from '../domain/dates.ts';
import {
  addOptions,
  gameKind,
  inAutomaticLineup,
  moveOptions,
  overrideFor,
  planIrChange,
  type AddOption,
  type DayChange,
  type GameKind,
  type IrPlan,
  type Lineup,
} from '../domain/lineupActions.ts';
import { expandSeats, type DayResult, type LineupPlayer, type UnusedReason } from '../domain/optimizer.ts';
import { opponent } from '../domain/schedule.ts';
import type { ISODate } from '../domain/types.ts';
import { dailyGroupCounts, lineupGroupTotals } from '../domain/capacity.ts';
import { useApp, type Window } from './context.ts';
import { PosBadges, PreferredToggle } from './common.tsx';

/**
 * Lineup page (UX redesign v1, 2026-11-22): the week grid is the whole editor. Tapping a game, a player
 * or a date opens a contextual sheet (bottom sheet on phones, side panel on desktop). Manual changes
 * are saved per date as exact lineups, as the old day editor saved them; Reset Day to Optimal and
 * Reset <period> to Optimal work as before.
 */
type SheetState = { kind: 'game'; date: ISODate; playerId: string } | { kind: 'player'; playerId: string } | { kind: 'day'; date: ISODate };

export function LineupView({ onGoRoster }: { onGoRoster: () => void }) {
  const { state, selected, lineupPlayers, dispatch, summarizeWindow, days } = useApp();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (s: SheetState, el?: HTMLElement | null) => {
    if (el) opener.current = el;
    setSheet(s);
  };
  // Closing returns focus (and so the reader's place) to what opened the sheet; the grid never scrolls.
  const close = () => {
    setSheet(null);
    const el = opener.current;
    requestAnimationFrame(() => el?.isConnected && el.focus({ preventScroll: true }));
  };
  useEffect(() => {
    if (sheet && 'date' in sheet && !selected.dates.includes(sheet.date)) setSheet(null);
    if (sheet && 'playerId' in sheet && !lineupPlayers.some((p) => p.id === sheet.playerId)) setSheet(null);
  }, [selected, sheet, lineupPlayers]);

  if (state.roster.length === 0) {
    return (
      <div className="panel empty">
        <strong>Add your roster to see how many games fit your lineup</strong>
        <button className="btn primary" onClick={onGoRoster} style={{ marginTop: 8 }}>
          Add Players
        </button>
      </div>
    );
  }

  const summary = summarizeWindow(selected);
  const manualDates = selected.dates.filter((d) => days.get(d)?.manual);
  const issueDates = selected.dates.filter((d) => days.get(d)?.manualIssues.length);

  return (
    <div className="stack">
      <SummaryCards />
      <section className="panel">
        <div className="panel-head">
          <h2>
            {selected.name}: {summary.usable} of {summary.scheduled} scheduled games fit your lineup
          </h2>
          {manualDates.length > 0 && (
            <>
              <span className="badge manual" title="Days where you swapped players. Other days are fully optimized.">
                Your changes on {manualDates.length} day{manualDates.length === 1 ? '' : 's'}
                {summary.usable < summary.optimalUsable ? ` · optimal ${summary.optimalUsable}` : ''}
              </span>
              {issueDates.length > 0 && (
                <button
                  className="badge warn"
                  style={{ border: 0, cursor: 'pointer' }}
                  onClick={(e) => open({ kind: 'day', date: issueDates[0]! }, e.currentTarget)}
                  title={issueDates.map(formatShort).join(', ')}
                >
                  {issueDates.length} day{issueDates.length === 1 ? ' has' : 's have'} changes that no longer apply
                </button>
              )}
              <button
                className="btn small"
                onClick={() => {
                  if (confirm('Revert lineup changes?')) dispatch({ type: 'clearManual', dates: manualDates });
                }}
              >
                Reset {selected.name} to Optimal
              </button>
            </>
          )}
        </div>
        <Legend />
        <p className="grid-hint small">Tap a game to change your lineup. Tap a player for player options, or a date for that day’s lineup.</p>
        <LineupGrid window={selected} players={lineupPlayers} sheet={sheet} onOpen={open} />
      </section>
      {sheet && (
        <SheetContent sheet={sheet} onOpen={open} onClose={close} />
      )}
    </div>
  );
}

function SummaryCards() {
  const { windows, selected, dispatch, summarizeWindow, lineupPlayers } = useApp();
  const shown = windows.filter((w) => w.id !== 'custom' || selected.id === 'custom');
  return (
    <div className="cards">
      {shown.map((w) => {
        const s = summarizeWindow(w);
        const t = lineupGroupTotals(s.players, lineupPlayers);
        const pct = t.all.scheduled ? Math.round((t.all.inLineup / t.all.scheduled) * 100) : 0;
        return (
          <button key={w.id} className="card" aria-pressed={w.id === selected.id} onClick={() => dispatch({ type: 'select', selection: w.id })}>
            <div className="label">{w.name}</div>
            <div className="big">
              {t.all.inLineup} <small>of {t.all.scheduled}</small>
            </div>
            <div className="sub" title="Scheduled games of your non-IR players that are in your final daily lineups">games fit your lineup</div>
            <div className="sub">
              <span title={`In lineup / scheduled games in ${w.name}, summed from the player rows (players on IR excluded)`}>
                <span style={{ whiteSpace: 'nowrap' }}>Skaters {t.skaters.inLineup}/{t.skaters.scheduled}</span> ·{' '}
                <span style={{ whiteSpace: 'nowrap' }}>Goalies {t.goalies.inLineup}/{t.goalies.scheduled}</span>
              </span>
              {s.manualDays ? <> · <span className="badge manual" title={`Your changes on ${s.manualDays} day${s.manualDays === 1 ? '' : 's'}`}>edited</span></> : null}
            </div>
            <div className="meter">
              <div style={{ width: `${pct}%` }} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="panel-body legend" style={{ paddingBottom: 0 }}>
      <span>
        <span className="cell used" /> In lineup
      </span>
      <span>
        <span className="cell opp" /> Fits: can be added
      </span>
      <span>
        <span className="cell unused" /> Not in lineup: another player has the spot
      </span>
      <span>
        <span className="cell blocked" /> No slot for this position
      </span>
      <span>
        <span className="cell ir" /> On IR
      </span>
      <span>
        <span className="star" aria-hidden="true" style={{ color: 'var(--warn)' }}>★</span> Preferred: gets lineup spots first
      </span>
      <span>
        <b className="count-key">Skaters, Goalies</b> rows: players with a game / active lineup slots
      </span>
    </div>
  );
}

const CELL_CLASS: Record<GameKind, string> = { 'in-lineup': 'used', ir: 'ir', opportunity: 'opp', priority: 'unused', constraint: 'blocked' };
const KIND_TEXT: Record<GameKind, string> = {
  'in-lineup': 'in lineup',
  ir: 'on IR',
  opportunity: 'fits, can be added',
  priority: 'not in lineup, another player has the spot',
  constraint: 'no lineup slot for this position',
};

function useSeats() {
  const { state } = useApp();
  return useMemo(() => expandSeats(state.league.slots), [state.league.slots]);
}

function LineupGrid(props: { window: Window; players: LineupPlayer[]; sheet: SheetState | null; onOpen: (s: SheetState, el?: HTMLElement | null) => void }) {
  const { days, data, summarizeWindow, state } = useApp();
  const seats = useSeats();
  const summary = summarizeWindow(props.window);
  const totals = new Map(summary.players.map((p) => [p.playerId, p]));
  const byId = useMemo(() => new Map(props.players.map((p) => [p.id, p])), [props.players]);
  const isGoalie = (p: LineupPlayer) => p.positions.every((x) => x === 'G');
  const groups = [
    { label: 'Skaters', rows: props.players.filter((p) => !p.onIr && !isGoalie(p)) },
    { label: 'Goalies', rows: props.players.filter((p) => !p.onIr && isGoalie(p)) },
    { label: 'IR', rows: props.players.filter((p) => p.onIr) },
  ].filter((g) => g.rows.length);
  const statusOf = (d: DayResult, id: string) => d.players.find((x) => x.playerId === id);
  const counts = new Map(props.window.dates.map((d) => [d, dailyGroupCounts(days.get(d)!, props.players, state.league.slots)]));
  // What each game means (in lineup, an opportunity, priority, constraint, IR), from the current lineups.
  const kinds = useMemo(() => {
    const m = new Map<string, GameKind>();
    for (const d of props.window.dates) {
      const day = days.get(d)!;
      for (const p of props.players) {
        const k = gameKind(day, p.id, byId, seats);
        if (k) m.set(`${d}|${p.id}`, k);
      }
    }
    return m;
  }, [props.window.dates, props.players, days, byId, seats]);
  const s = props.sheet;
  const selDate = s && 'date' in s ? s.date : null;
  const selPlayer = s && 'playerId' in s ? s.playerId : null;
  const openDay = (d: ISODate, el: HTMLElement) => props.onOpen({ kind: 'day', date: d }, el);
  const countRow = (group: 'skaters' | 'goalies', label: string) => (
    <tr className="count-row">
      <th className="sticky" title={`${label} with a game that day / active ${label.toLowerCase()} lineup slots`}>
        {label}
      </th>
      {props.window.dates.map((d) => {
        const c = counts.get(d)![group];
        return (
          <th
            key={d}
            className={`cnt ${c.available > c.capacity ? 'over' : ''} ${selDate === d ? 'sel' : ''}`}
            title={`${formatShort(d)}: ${c.available} ${label.toLowerCase()} with a game, ${c.capacity} active slots`}
            onClick={(e) => openDay(d, e.currentTarget)}
          >
            {c.available}/{c.capacity}
          </th>
        );
      })}
      <th />
    </tr>
  );

  return (
    <div className="grid-wrap">
      <table className="lgrid">
        <thead>
          {countRow('skaters', 'Skaters')}
          {countRow('goalies', 'Goalies')}
          <tr>
            <th className="sticky">Player</th>
            {props.window.dates.map((d) => (
              <th key={d} className={`dh ${selDate === d ? 'sel' : ''} ${days.get(d)?.manualIssues.length ? 'issue' : days.get(d)?.manual ? 'man' : ''}`}>
                <button
                  type="button"
                  className="day-btn"
                  aria-pressed={s?.kind === 'day' && s.date === d}
                  aria-label={`${weekday(d)} ${formatShort(d)}${days.get(d)?.manual ? ', your changes' : ''}`}
                  onClick={(e) => openDay(d, e.currentTarget)}
                  title={`${weekday(d)} ${formatShort(d)} · ${data.schedule.gamesOn(d).length} NHL games${days.get(d)?.manual ? ' · your changes' : ''}`}
                >
                  {weekday(d)[0]}
                  <br />
                  {Number(d.slice(8))}
                </button>
              </th>
            ))}
            <th className="tot" title="Games in your lineup / games scheduled for this player's team">
              In Lineup
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.label} label={g.label} cols={props.window.dates.length}>
              {g.rows.map((p) => {
                const t = totals.get(p.id);
                return (
                  <tr key={p.id} className={selPlayer === p.id ? 'row-sel' : undefined}>
                    <td className="sticky">
                      <PreferredToggle id={p.id} name={p.name} preferred={!!p.preferred} />{' '}
                      <button type="button" className="name-btn" onClick={(e) => props.onOpen({ kind: 'player', playerId: p.id }, e.currentTarget)} aria-label={`${p.name}: player options`}>
                        {p.name}
                      </button>{' '}
                      <PosBadges positions={p.positions} />
                    </td>
                    {props.window.dates.map((d) => {
                      const st = statusOf(days.get(d)!, p.id);
                      const kind = kinds.get(`${d}|${p.id}`);
                      let title = '';
                      if (st?.game && kind) {
                        const o = opponent(st.game, st.team);
                        title = `${formatShort(d)} ${o.home ? 'vs' : '@'} ${o.team} — ${KIND_TEXT[kind]}`;
                      }
                      const here = s?.kind === 'game' && s.date === d && s.playerId === p.id;
                      return (
                        <td key={d} className={`c ${selDate === d ? 'sel' : ''} ${here ? 'here' : ''}`} title={title}>
                          {kind && (
                            <button
                              type="button"
                              className="cell-btn"
                              aria-label={`${p.name}, ${weekday(d)} ${formatShort(d)}: ${KIND_TEXT[kind]}`}
                              onClick={(e) => props.onOpen({ kind: 'game', date: d, playerId: p.id }, e.currentTarget)}
                            >
                              <span className={`cell ${CELL_CLASS[kind]}`} />
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="tot">
                      {t?.usable ?? 0}/{t?.scheduled ?? 0}
                    </td>
                  </tr>
                );
              })}
            </GroupRows>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="sticky small">In Lineup / Your Games</td>
            {props.window.dates.map((d) => {
              const day = days.get(d)!;
              return (
                <td key={d} title={`${day.usable} of ${day.scheduled} games fit your lineup${day.manual ? ` (your changes; optimal ${day.optimalUsable})` : ''}`} style={day.manual ? { color: 'var(--accent)' } : undefined}>
                  {day.scheduled ? `${day.usable}` : '·'}
                  <br />
                  <span style={{ fontWeight: 400 }}>{day.scheduled || ''}</span>
                </td>
              );
            })}
            <td className="tot">
              {summary.usable}/{summary.scheduled}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function GroupRows({ label, cols, children }: { label: string; cols: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="group">
        <td className="sticky" style={{ background: 'var(--surface-2)' }}>
          {label}
        </td>
        <td colSpan={cols + 1} />
      </tr>
      {children}
    </>
  );
}

export function reasonText(r: UnusedReason): string {
  switch (r.kind) {
    case 'ir':
      return 'on IR';
    case 'no-slot':
      return `no lineup slot accepts ${r.positions.join('/')}`;
    case 'slots-full':
      return `${r.slotLabels.join('/')} full (${r.occupants.join(', ')})`;
    case 'benched':
      return 'benched with an open slot';
    case 'sat':
      return 'sitting out by your choice';
  }
}

// ---------------------------------------------------------------------------
// Sheets: a bottom sheet on phones, a side panel on desktop (CSS). Escape and the backdrop close them.

function Sheet({ label, title, onClose, children }: { label: string; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus the sheet once when it opens (not on every update); Escape closes it.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="sheet-layer">
      <div className="sheet-backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        <div className="sheet-head">
          <div className="sheet-title">{title}</div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}

function SheetContent({ sheet, onOpen, onClose }: { sheet: SheetState; onOpen: (s: SheetState) => void; onClose: () => void }) {
  if (sheet.kind === 'game') return <GameSheet key={`${sheet.date}|${sheet.playerId}`} date={sheet.date} playerId={sheet.playerId} onOpen={onOpen} onClose={onClose} />;
  if (sheet.kind === 'player') return <PlayerSheet key={sheet.playerId} playerId={sheet.playerId} onClose={onClose} />;
  return <DaySheet date={sheet.date} onOpen={onOpen} onClose={onClose} />;
}

/** Saves one date's new lineup (only that date changes), as the old day editor did. */
function useSaveDay() {
  const { state, dispatch, lineupPlayers, data, toast } = useApp();
  const seats = useSeats();
  return (date: ISODate, next: Lineup) => {
    dispatch({ type: 'setManual', date, override: overrideFor(date, next, lineupPlayers, seats, data.schedule, state.manual[date]?.notes) });
    toast('Lineup saved.');
  };
}

function useMatchup(day: DayResult) {
  return (id: string) => {
    const st = day.players.find((x) => x.playerId === id);
    if (!st?.game) return 'No game';
    const o = opponent(st.game, st.team);
    return `${o.home ? 'vs' : '@'} ${o.team}`;
  };
}

/** The date's status line with Reset Day to Optimal (unchanged behavior: clears that day's changes). */
function DayStatus({ day }: { day: DayResult }) {
  const { dispatch } = useApp();
  return (
    <div className="sheet-day">
      <div className="small">
        {weekday(day.date)} {formatShort(day.date)}: {day.usable} of {day.scheduled} games fit your lineup{' '}
        {day.manual ? <span className="badge manual">Your Changes</span> : <span className="badge good">Optimized</span>}
      </div>
      {day.manual && (
        <>
          <p className="section-hint">This day keeps your saved lineup; starring or unstarring players won’t change it. Choose Reset Day to Optimal to follow current stars.</p>
          <button className="btn small" onClick={() => dispatch({ type: 'setManual', date: day.date, override: null })}>
            Reset Day to Optimal
          </button>
        </>
      )}
    </div>
  );
}

function GameSheet({ date, playerId, onOpen, onClose }: { date: ISODate; playerId: string; onOpen: (s: SheetState) => void; onClose: () => void }) {
  const { days, lineupPlayers, data } = useApp();
  const seats = useSeats();
  const save = useSaveDay();
  const [confirming, setConfirming] = useState<AddOption | null>(null);
  const day = days.get(date)!;
  const byId = new Map(lineupPlayers.map((p) => [p.id, p]));
  const p = byId.get(playerId)!;
  const matchup = useMatchup(day);
  const kind = gameKind(day, playerId, byId, seats);
  const name = (id?: string) => (id ? (byId.get(id)?.name ?? id) : '');
  const seatLabel = day.seats.find((x) => x.playerId === playerId)?.seat.label;
  const options = kind === 'opportunity' || kind === 'priority' ? addOptions(day, playerId, lineupPlayers, seats) : [];
  const title = (
    <>
      <b>{p.name}</b> <PosBadges positions={p.positions} />
      <div className="small muted">
        {weekday(date)} {formatShort(date)} · {matchup(playerId)}
      </div>
    </>
  );

  let body: ReactNode;
  if (confirming) {
    const o = confirming;
    body = (
      <div className="stack">
        <p>
          Replace <b>{name(o.outId)}</b> with <b>{p.name}</b> at {o.seatLabel} on {weekday(date)} {formatShort(date)}?
        </p>
        <ul className="trade-list">
          <li className="gain">Gain: {p.name} {matchup(playerId)}</li>
          <li className="lose">Give up: {name(o.outId)} {matchup(o.outId!)}</li>
        </ul>
        <p className="small muted">Only this day changes. The day still has {day.usable} games in your lineup.</p>
        <div className="sheet-actions">
          <button
            className="btn primary"
            onClick={() => {
              save(date, o.next);
              setConfirming(null);
            }}
          >
            Replace
          </button>
          <button className="btn" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (kind === 'in-lineup') {
    const moves = moveOptions(day, playerId, lineupPlayers, seats);
    const bench = moves.find((m) => !m.seatKey);
    body = (
      <div className="stack">
        <p>
          In your lineup at <b>{seatLabel}</b>.
        </p>
        {moves.some((m) => m.seatKey) && (
          <div className="sheet-options" aria-label="Change position">
            {moves
              .filter((m) => m.seatKey)
              .map((m) => (
                <button key={m.seatKey} className="option-btn" onClick={() => save(date, m.next)}>
                  Move to {m.seatLabel}
                  {m.withId ? <span className="small muted"> · swap with {name(m.withId)}</span> : null}
                </button>
              ))}
          </div>
        )}
        {bench && (
          <button className="option-btn lose" onClick={() => save(date, bench.next)}>
            Remove from lineup <span className="small muted">· gives up this game</span>
          </button>
        )}
      </div>
    );
  } else if (kind === 'ir') {
    body = (
      <div className="stack">
        <p>{p.name} is on IR, so this game can’t count.</p>
        <button className="option-btn" onClick={() => onOpen({ kind: 'player', playerId })}>
          Player options…
        </button>
      </div>
    );
  } else if (kind === 'constraint') {
    body = <p>No lineup slot in your league accepts {p.positions.join('/') || 'this player'}, so this game can’t count.</p>;
  } else if (kind === 'opportunity') {
    const fromChanges = day.manual && inAutomaticLineup(date, playerId, lineupPlayers, seats, data.schedule);
    body = (
      <div className="stack">
        <p>{fromChanges ? 'Your changes for this day left this game out. It fits without giving up another game.' : 'This game fits your lineup without giving up another game.'}</p>
        <div className="sheet-options">
          {options
            .filter((o) => o.kind === 'open')
            .map((o) => (
              <button key={o.seatKey} className="option-btn gain" onClick={() => save(date, o.next)}>
                Add at {o.seatLabel}
                {o.outId ? <span className="small muted"> · {name(o.outId)} (no game) goes to the bench</span> : null}
              </button>
            ))}
        </div>
      </div>
    );
  } else if (kind === 'priority') {
    const replace = options.filter((o) => o.kind === 'replace');
    body = (
      <div className="stack">
        <p>Every lineup spot {p.name} can play is held by a player with a game{day.manual ? '' : ' (★ stars and roster order decide who starts)'}. Adding this game means giving up another.</p>
        {replace.length > 0 && (
          <div className="sheet-options" aria-label="Replacement options">
            {replace.map((o) => (
              <button key={o.outId} className="option-btn" onClick={() => setConfirming(o)}>
                <span>
                  Start at {o.seatLabel} instead of <b>{name(o.outId)}</b>
                  {o.suggested && <span className="badge good" style={{ marginLeft: 6 }}>Suggested</span>}
                </span>
                <span className="small">
                  <span className="gain-text">Gain {matchup(playerId)}</span> · <span className="lose-text">Give up {name(o.outId)} {matchup(o.outId!)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <Sheet label={`${p.name}, ${weekday(date)} ${formatShort(date)}`} title={title} onClose={onClose}>
      {body}
      <DayStatus day={day} />
    </Sheet>
  );
}

function ChangeList({ changes, emptyText }: { changes: DayChange[]; emptyText: string }) {
  const { lineupPlayers } = useApp();
  const name = (id: string) => lineupPlayers.find((p) => p.id === id)?.name ?? id;
  if (changes.length === 0) return <p className="small muted">{emptyText}</p>;
  return (
    <ul className="change-list">
      {changes.map((c) => (
        <li key={c.date}>
          <b>
            {weekday(c.date)} {formatShort(c.date)}:
          </b>{' '}
          {c.added.map((id) => (
            <span key={`+${id}`} className="gain-text">
              + {name(id)}{' '}
            </span>
          ))}
          {c.removed.map((id) => (
            <span key={`-${id}`} className="lose-text">
              − {name(id)}{' '}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function PlayerSheet({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const { state, dispatch, lineupPlayers, selected, summarizeWindow, data, teams, toast } = useApp();
  const seats = useSeats();
  const [step, setStep] = useState<{ kind: 'confirm'; plan: IrPlan; toIr: boolean } | { kind: 'done'; plan: IrPlan; toIr: boolean } | null>(null);
  const p = lineupPlayers.find((x) => x.id === playerId);
  if (!p) return null;
  const t = summarizeWindow(selected).players.find((x) => x.playerId === playerId);
  const irCount = state.roster.filter((e) => e.onIr).length;
  const activeCount = state.roster.length - irCount;
  const irFull = irCount >= state.league.irSlots;
  const ask = (toIr: boolean) => setStep({ kind: 'confirm', toIr, plan: planIrChange(playerId, toIr, lineupPlayers, selected.dates, seats, data.schedule, state.manual) });
  const title = (
    <>
      <b>{p.name}</b> <PosBadges positions={p.positions} />
      <div className="small muted">{teams.get(p.team)?.name ?? p.team}</div>
    </>
  );

  let body: ReactNode;
  if (step?.kind === 'confirm') {
    const { plan, toIr } = step;
    body = (
      <div className="stack">
        {toIr ? (
          <p>
            <b>{p.name}</b> will leave your lineup on every day and use an IR slot. Days you haven’t changed are re-optimized; on days you changed, only {p.name}’s spot is refilled.
          </p>
        ) : (
          <p>
            <b>{p.name}</b> returns to your active roster. Days you haven’t changed are re-optimized to include them where they fit; days you changed keep your lineup.
            {activeCount + 1 > state.league.rosterSize && ` Your active roster will have ${activeCount + 1} players; your limit is ${state.league.rosterSize}.`}
          </p>
        )}
        <p className="small">
          {selected.name}: {plan.before} → {plan.after} games fit your lineup.
        </p>
        <ChangeList changes={plan.changes} emptyText={`No lineup changes in ${selected.name}.`} />
        <div className="sheet-actions">
          <button
            className="btn primary"
            onClick={() => {
              dispatch({ type: 'applyIrChange', id: playerId, onIr: toIr, manual: plan.manual });
              setStep({ kind: 'done', plan, toIr });
              toast(toIr ? `${p.name} moved to IR.` : `${p.name} moved off IR.`);
            }}
          >
            {toIr ? 'Move to IR' : 'Move off IR'}
          </button>
          <button className="btn" onClick={() => setStep(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (step?.kind === 'done') {
    const { plan, toIr } = step;
    body = (
      <div className="stack">
        <p>
          {p.name} {toIr ? 'moved to IR' : 'moved off IR'}. {selected.name}: {plan.before} → {plan.after} games fit your lineup.
        </p>
        <h3 className="sheet-sub">What changed</h3>
        <ChangeList changes={plan.changes} emptyText={`No lineup changes in ${selected.name}.`} />
        <div className="sheet-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="stack">
        <div className="small">
          Status: <b>{p.onIr ? 'On IR' : 'Active'}</b> · Eligible: {p.positions.join(', ') || 'none'}
        </div>
        <div className="small">
          {selected.name}: in your lineup for {t?.usable ?? 0} of {t?.scheduled ?? 0} games
        </div>
        <div className="small">
          <PreferredToggle id={p.id} name={p.name} preferred={!!p.preferred} /> {p.preferred ? 'Preferred: gets lineup spots first' : 'Not preferred'}
        </div>
        {p.onIr ? (
          <button className="option-btn" onClick={() => ask(false)}>
            Move off IR
          </button>
        ) : (
          <>
            <button className="option-btn" disabled={irFull} onClick={() => ask(true)}>
              Move to IR
            </button>
            {irFull && (
              <p className="small muted">
                Your IR slots are full ({irCount} of {state.league.irSlots}).
              </p>
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <Sheet label={`${p.name}: player options`} title={title} onClose={onClose}>
      {body}
    </Sheet>
  );
}

function DaySheet({ date, onOpen, onClose }: { date: ISODate; onOpen: (s: SheetState) => void; onClose: () => void }) {
  const { days, lineupPlayers, data, teams, selected } = useApp();
  const day = days.get(date)!;
  const byId = new Map(lineupPlayers.map((p) => [p.id, p]));
  const matchup = useMatchup(day);
  const idx = selected.dates.indexOf(date);
  const seated = new Set(day.seats.flatMap((x) => (x.playerId ? [x.playerId] : [])));
  const bench = lineupPlayers.filter((p) => !p.onIr && !seated.has(p.id));
  const ir = lineupPlayers.filter((p) => p.onIr && day.players.find((x) => x.playerId === p.id)?.game);
  const nhlGames = data.schedule.gamesOn(date);
  const row = (label: string, p?: LineupPlayer) => (
    <button key={`${label}-${p?.id ?? 'empty'}`} className="day-row" disabled={!p} onClick={() => p && onOpen({ kind: 'game', date, playerId: p.id })}>
      <span className="day-row-pos">{label}</span>
      {p ? (
        <span>
          <b>{p.name}</b> <PosBadges positions={p.positions} /> <span className={`small ${day.players.find((x) => x.playerId === p.id)?.game ? '' : 'muted'}`}>{matchup(p.id)}</span>
        </span>
      ) : (
        <span className="empty-seat">Empty</span>
      )}
    </button>
  );
  const title = (
    <>
      <b>
        Lineup for {weekday(date)} {formatShort(date)}
      </b>
      <div className="day-nav">
        <button className="icon-btn" disabled={idx <= 0} onClick={() => onOpen({ kind: 'day', date: selected.dates[idx - 1]! })} aria-label="Previous day">
          ←
        </button>
        <button className="icon-btn" disabled={idx >= selected.dates.length - 1} onClick={() => onOpen({ kind: 'day', date: selected.dates[idx + 1]! })} aria-label="Next day">
          →
        </button>
      </div>
    </>
  );
  return (
    <Sheet label={`Lineup for ${weekday(date)} ${formatShort(date)}`} title={title} onClose={onClose}>
      {day.manualIssues.length > 0 && <div className="notice">Some of your changes for this day no longer apply and are being ignored: {day.manualIssues.join(' ')}</div>}
      <DayStatus day={day} />
      <h3 className="sheet-sub">In Lineup</h3>
      <div className="day-rows">{day.seats.map(({ seat, playerId }) => row(seat.label, playerId ? byId.get(playerId) : undefined))}</div>
      <h3 className="sheet-sub">Bench</h3>
      <div className="day-rows">{bench.length ? bench.map((p) => row('BN', p)) : <div className="muted small">Everyone is in the lineup.</div>}</div>
      {ir.length > 0 && <div className="small muted">On IR: {ir.map((p) => p.name).join(', ')}</div>}
      <h3 className="sheet-sub">NHL games ({nhlGames.length})</h3>
      <div className="game-chips">
        {nhlGames.map((g) => (
          <span key={g.id} className="game-chip" title={`${teams.get(g.away)?.name} at ${teams.get(g.home)?.name}`}>
            {g.away} @ {g.home}
          </span>
        ))}
        {nhlGames.length === 0 && <span className="muted small">No NHL games.</span>}
      </div>
    </Sheet>
  );
}
