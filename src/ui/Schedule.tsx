import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { formatShort, weekday } from '../domain/dates.ts';
import { playerSchedule } from '../domain/lineupActions.ts';
import { opponent } from '../domain/schedule.ts';
import type { ISODate } from '../domain/types.ts';
import { useApp, type Window } from './context.ts';
import { PosBadges, PreferredToggle } from './common.tsx';

/**
 * Schedule view (2026-11-23): every roster player × every date of the selected period, with the
 * opponent in each game cell, blue when the game is in the current lineup and neutral when it isn't.
 * It reads the same day results as the Lineup view (`days` from the app context), so both always
 * agree; tapping a game opens the shared player sheet for that date.
 *
 * Layout: the player column stays pinned while the dates scroll sideways inside the grid (never the
 * page). The date header is a separate strip, sticky under the tab bar, that follows the grid's
 * horizontal scroll, so dates stay visible during normal page scrolling (no nested vertical scroll).
 * The strip is hidden from screen readers; each game button names its date and opponent instead.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ScheduleGrid({ window: w, active, onCell }: { window: Window; active?: { playerId: string; date: ISODate }; onCell: (playerId: string, date: ISODate, el: HTMLElement) => void }) {
  const { days, lineupPlayers } = useApp();
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const list = w.dates.map((d) => days.get(d)!).filter(Boolean);
  const rows = [...lineupPlayers.filter((p) => !p.onIr), ...lineupPlayers.filter((p) => p.onIr)];
  // Both tables share these widths, so header and body columns line up exactly.
  const style = { '--sg-cols': w.dates.length } as CSSProperties;

  // The header sits just below the sticky tab bar (its height differs by screen width).
  useLayoutEffect(() => {
    const place = () => {
      const bar = document.querySelector('.tabbar')?.getBoundingClientRect().height ?? 0;
      if (head.current) head.current.style.top = `${Math.round(bar)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  useEffect(() => {
    if (head.current && body.current) head.current.scrollLeft = body.current.scrollLeft;
  });

  const header = (
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
  );
  const cols = (
    <colgroup>
      <col className="sg-col-name" />
      {list.map((d) => (
        <col key={d.date} className="sg-col-date" />
      ))}
    </colgroup>
  );

  return (
    <div className="sg" style={style}>
      <p className="sg-key small">
        <span className="sg-cell on sg-sample">VAN</span> In lineup <span className="sg-cell off sg-sample">VAN</span> Not in lineup
        <span className="muted">@ = away game. Tap a game for options.</span>
      </p>
      <div className="sg-head" ref={head} aria-hidden="true">
        <table className="sg-table">
          {cols}
          <thead>{header}</thead>
        </table>
      </div>
      <div className="sg-body" ref={body} onScroll={() => head.current && body.current && (head.current.scrollLeft = body.current.scrollLeft)}>
        <table className="sg-table">
          {cols}
          <tbody>
            {rows.map((p) => {
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
        </table>
      </div>
    </div>
  );
}
