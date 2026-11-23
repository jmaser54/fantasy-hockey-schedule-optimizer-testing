import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { formatShort, weekday } from '../domain/dates.ts';
import { playerSchedule } from '../domain/lineupActions.ts';
import type { LineupPlayer } from '../domain/optimizer.ts';
import { opponent } from '../domain/schedule.ts';
import type { ISODate } from '../domain/types.ts';
import { useApp, type Window } from './context.ts';
import { PosBadges, PreferredToggle } from './common.tsx';

/**
 * Schedule view (2026-11-23): every roster player × every date of the selected period, with the
 * opponent in each game cell, blue when the game is in the current lineup and neutral when it isn't.
 * It reads the same day results as the Lineup view (`days` from the app context), so both always
 * agree; tapping a game opens the shared player sheet for that date. Rows are grouped Skaters,
 * Goalies, IR (roster order within each group).
 *
 * Scrolling (fixed 2026-11-23): the whole grid is ONE native scroll container holding one table.
 * The date header is `position: sticky; top: 0` and the player column `sticky; left: 0` inside it, so
 * the browser keeps them aligned with the cells on its own (no JavaScript syncing, which lagged and
 * misaligned on iOS during momentum scrolling and edge bounce). The container is never taller than the
 * visible screen below the tab bar, so both sticky edges stay on screen; a short grid doesn't scroll
 * vertically at all and the page scrolls as usual.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isGoalie = (p: LineupPlayer) => p.positions.length > 0 && p.positions.every((x) => x === 'G');

export function ScheduleGrid({ window: w, active, onCell }: { window: Window; active?: { playerId: string; date: ISODate }; onCell: (playerId: string, date: ISODate, el: HTMLElement) => void }) {
  const { days, lineupPlayers } = useApp();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const list = w.dates.map((d) => days.get(d)!).filter(Boolean);
  const groups = [
    { label: 'Skaters', rows: lineupPlayers.filter((p) => !p.onIr && !isGoalie(p)) },
    { label: 'Goalies', rows: lineupPlayers.filter((p) => !p.onIr && isGoalie(p)) },
    { label: 'IR', rows: lineupPlayers.filter((p) => p.onIr) },
  ].filter((g) => g.rows.length > 0);
  const style = { '--sg-cols': w.dates.length } as CSSProperties;

  // The grid's height limit leaves room for the sticky tab bar (its height differs by screen width).
  // Vertical swipes go to the page until the grid reaches the top of the screen (or while its rows are
  // already scrolled), so the page never gets "stuck" behind a half-visible grid; then the grid scrolls
  // its rows under its sticky header, and at its ends the page continues.
  // Content below the grid (panel padding, footer) is subtracted from its height limit, so at the
  // page's furthest scroll the grid's top sits exactly under the tab bar and its header never hides.
  const measureBelow = () => {
    const el = scroller.current;
    if (!el) return;
    const below = Math.max(0, document.documentElement.scrollHeight - (el.getBoundingClientRect().bottom + window.scrollY));
    root.current?.style.setProperty('--sg-below', `${Math.round(below)}px`);
  };
  useLayoutEffect(measureBelow);
  useLayoutEffect(() => {
    let bar = 0;
    const pin = () => {
      const el = scroller.current;
      if (!el) return;
      const pinned = el.getBoundingClientRect().top <= bar + 1 || el.scrollTop > 0;
      if (pinned !== el.hasAttribute('data-pinned')) el.toggleAttribute('data-pinned', pinned);
    };
    const place = () => {
      bar = Math.round(document.querySelector('.tabbar')?.getBoundingClientRect().height ?? 0);
      root.current?.style.setProperty('--sg-top', `${bar}px`);
      measureBelow();
      pin();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', pin, { passive: true });
    const el = scroller.current;
    el?.addEventListener('scroll', pin, { passive: true });
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', pin);
      el?.removeEventListener('scroll', pin);
    };
  }, []);

  return (
    <div className="sg" style={style} ref={root}>
      <p className="sg-key small">
        <span className="sg-cell on sg-sample">TEAM</span> In lineup <span className="sg-cell off sg-sample">TEAM</span> Not in lineup
        <span className="muted">@ = away game. Tap a game for options.</span>
      </p>
      <div className="sg-scroll" ref={scroller}>
        <table className="sg-table">
          <colgroup>
            <col className="sg-col-name" />
            {list.map((d) => (
              <col key={d.date} className="sg-col-date" />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sg-name sg-corner">Player</th>
              {list.map((d, i) => {
                const showMonth = i === 0 || d.date.slice(8) === '01';
                return (
                  <th key={d.date} className="sg-date" title={`${weekday(d.date)} ${formatShort(d.date)}: ${d.usable} of ${d.scheduled} games fit your lineup`}>
                    <span className="sg-month">{showMonth ? MONTHS[Number(d.date.slice(5, 7)) - 1] : ' '}</span>
                    <span className="sg-wd">{weekday(d.date).slice(0, 2)}</span>
                    <span className="sg-dn">{Number(d.date.slice(8))}</span>
                    <span className={`sg-fit ${d.manual ? 'man' : ''}`} aria-label={`${d.usable} of ${d.scheduled} games fit`}>
                      {d.scheduled ? `${d.usable}/${d.scheduled}` : '–'}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.label} className="sg-group">
              <tr className="sg-group-row">
                <th scope="colgroup" className="sg-name sg-group-label">
                  {g.label} <span className="sg-group-count">{g.rows.length}</span>
                </th>
                <td className="sg-group-fill" colSpan={list.length} />
              </tr>
              {g.rows.map((p) => {
                const cells = playerSchedule(list, p.id);
                return (
                  <tr key={p.id} className={`sg-row ${p.onIr ? 'sg-ir' : ''}`}>
                    <th scope="row" className="sg-name">
                      <span className="sg-name-in">
                        <PreferredToggle id={p.id} name={p.name} preferred={!!p.preferred} />
                        <span className="sg-player">
                          <span className="sg-pname">{p.name}</span>
                          <span className="sg-meta">
                            <PosBadges positions={p.positions} />
                            {p.onIr && <span className="badge">IR</span>}
                          </span>
                        </span>
                      </span>
                    </th>
                    {cells.map((c) => {
                      if (!c.game) return <td key={c.date} className="sg-td" />;
                      const st = days.get(c.date)!.players.find((x) => x.playerId === p.id)!;
                      const o = opponent(c.game, st.team);
                      const here = active?.playerId === p.id && active.date === c.date;
                      const text = `${o.home ? '' : '@'}${o.team}`;
                      return (
                        <td key={c.date} className="sg-td">
                          <button
                            type="button"
                            className={`sg-cell ${c.assigned ? 'on' : 'off'} ${here ? 'here' : ''}`}
                            aria-label={`${p.name}, ${weekday(c.date)} ${formatShort(c.date)}, ${o.home ? 'vs' : 'at'} ${o.team}: ${c.assigned ? 'in your lineup' : 'not in your lineup'}`}
                            onClick={(e) => onCell(p.id, c.date, e.currentTarget)}
                          >
                            {text}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
