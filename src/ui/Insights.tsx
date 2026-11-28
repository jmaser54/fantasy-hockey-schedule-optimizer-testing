import { useEffect, useMemo, useState } from 'react';
import type { InsightsInputsFile } from '../data/format.ts';
import { insightsDataFresh, loadInsightsInputs, loadOwnership, ownershipForRanking, type OwnershipData } from '../data/load.ts';
import { CUSTOM_SHOWN } from '../domain/insightsSettings.ts';
import { customInsights, generalInsights, type CustomCard, type InsightLine } from '../domain/insightsRules.ts';
import type { InsightContext } from '../domain/insightsValue.ts';
import { customInsightsReady, setupNeeds } from '../state/appState.ts';
import { useApp } from './context.ts';

type Loaded = { insights?: InsightsInputsFile; ownership?: OwnershipData };
let cache: Promise<Loaded> | undefined;
/** Insights files are optional and loaded once per visit, only when an Insights page opens. */
function useInsightsData(season: string): Loaded | undefined {
  const [data, setData] = useState<Loaded>();
  useEffect(() => {
    cache ??= Promise.all([loadInsightsInputs(season), loadOwnership(season)]).then(([insights, ownership]) => ({ insights, ownership }));
    let live = true;
    void cache.then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [season]);
  return data;
}

function Lines({ lines }: { lines: readonly InsightLine[] }) {
  return (
    <ul className="insight-lines">
      {lines.map((l, i) => (
        <li key={i} className={`insight-line ${l.basis}`}>
          {l.basis === 'expectation' && <span className="insight-tag">Estimate</span>}
          {l.text}
        </li>
      ))}
    </ul>
  );
}

function DataNotice({ data }: { data: Loaded | undefined }) {
  if (!data) return <div className="empty">Loading Insights…</div>;
  if (!data.insights) return <div className="notice">Insights data isn’t available yet. It’s built by the regular NHL data refresh; check back later.</div>;
  return <div className="notice">Insights data is more than 48 hours old, so nothing is shown until the next refresh.</div>;
}

/** General Insights: league-wide, always available, no roster or settings needed. */
export function GeneralInsightsView() {
  const { data, weekWindow } = useApp();
  const loaded = useInsightsData(data.season);
  const fresh = insightsDataFresh(loaded?.insights);
  const result = useMemo(
    () => (fresh && loaded?.insights ? generalInsights({ insights: loaded.insights, directory: data.players, schedule: data.schedule, nextWeek: weekWindow.dates, teamName: (t) => t }) : undefined),
    [fresh, loaded, data.players, data.schedule, weekWindow.dates],
  );
  const empty = result && !result.roles.length && !result.production.length && !result.categories.length && !result.goalies.length;
  return (
    <div className="stack insights">
      <section className="panel" aria-label="General Insights">
        <div className="panel-head">
          <h2>General Insights</h2>
          <span className="small muted">League-wide NHL player intelligence. No setup needed.</span>
        </div>
        <div className="panel-body insight-body">
          {!result && <DataNotice data={loaded} />}
          {empty && <div className="empty">Nothing stands out right now.</div>}
          {result && result.roles.length > 0 && (
            <InsightGroup title="Power-play role changes (forwards)" note="Confirmed by 6 of the last 8 games; based on game data through the latest refresh.">
              {result.roles.map((r) => (
                <ItemCard key={r.id} title={`${r.name}`} team={r.team} lines={r.lines} />
              ))}
            </InsightGroup>
          )}
          {result && result.production.length > 0 && (
            <InsightGroup title="Production changes" note="Full-season samples only; short streaks aren’t shown.">
              {result.production.map((r) => (
                <ItemCard key={r.id} title={r.name} team={r.team} lines={r.lines} />
              ))}
            </InsightGroup>
          )}
          {result && result.categories.length > 0 && (
            <InsightGroup title="Category contributors" note="Expected per game, once each player has enough games for that category to be trusted.">
              <div className="cat-leaders">
                {result.categories.map((c) => (
                  <div key={c.cat} className="insight-card">
                    <div className="insight-title">{c.label}</div>
                    <ol className="leaders">
                      {c.leaders.map((l) => (
                        <li key={l.id}>
                          {l.name} <span className="muted">{l.team}</span> <span className="num">{l.perGame.toFixed(c.cat === 'ppp' ? 2 : 1)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </InsightGroup>
          )}
          {result && result.goalies.length > 0 && (
            <InsightGroup title="Goalie workload" note="Verified starts only. No starts are predicted.">
              {result.goalies.map((r) => (
                <ItemCard key={r.id} title={r.name} team={r.team} lines={r.lines} />
              ))}
            </InsightGroup>
          )}
        </div>
      </section>
    </div>
  );
}

function InsightGroup({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="insight-group">
      <h3>{title}</h3>
      {note && <p className="small muted insight-note">{note}</p>}
      <div className="insight-cards">{children}</div>
    </section>
  );
}

function ItemCard({ title, team, lines, children }: { title: string; team: string; lines: readonly InsightLine[]; children?: React.ReactNode }) {
  return (
    <article className="insight-card">
      <div className="insight-title">
        {title} <span className="muted">{team}</span>
      </div>
      <Lines lines={lines} />
      {children}
    </article>
  );
}

/** Custom Insights: the best moves for this roster. Opens only when setup is complete. */
export function CustomInsightsView({ onGoRoster, onGoTrades }: { onGoRoster: () => void; onGoTrades: () => void }) {
  const { state, data, resolve, weekWindow, playoffWindows, dispatch, openSettings } = useApp();
  const loaded = useInsightsData(data.season);
  const [ctx, setCtx] = useState<InsightContext>('nextWeek');
  const [all, setAll] = useState(false);
  const ready = customInsightsReady(state);
  const fresh = insightsDataFresh(loaded?.insights);
  const rounds = useMemo(() => playoffWindows.filter((w) => w.id !== 'all'), [playoffWindows]);
  const playoffDates = useMemo(() => [...new Set(rounds.flatMap((r) => r.dates))].sort(), [rounds]);
  const result = useMemo(() => {
    if (!ready || !fresh || !loaded?.insights) return undefined;
    return customInsights({
      ctx,
      dates: ctx === 'nextWeek' ? weekWindow.dates : playoffDates,
      rounds: ctx === 'playoffs' ? rounds : undefined,
      futureDates: playoffDates,
      roster: state.roster,
      resolve,
      directory: data.players,
      league: state.league,
      scoring: state.scoring,
      insights: loaded.insights,
      ownership: ownershipForRanking(loaded.ownership),
      schedule: data.schedule,
      teamName: (t) => t,
    });
  }, [ready, fresh, loaded, ctx, weekWindow.dates, playoffDates, rounds, state.roster, state.league, state.scoring, resolve, data.players, data.schedule]);

  if (!ready) {
    const needs = setupNeeds(state);
    return (
      <div className="stack insights">
        <section className="panel" aria-label="Custom Insights">
          <div className="panel-head">
            <h2>Custom Insights</h2>
          </div>
          <div className="panel-body insight-body">
            <p>Custom Insights finds the best moves for your team. It needs your setup first:</p>
            <ul className="setup-list">
              {needs.roster && (
                <li>
                  Add your roster.{' '}
                  <button className="btn small" onClick={onGoRoster}>
                    My Roster
                  </button>
                </li>
              )}
              {needs.league && (
                <li>
                  Complete League Settings, including your scoring categories (review and Save).{' '}
                  <button className="btn small" onClick={openSettings}>
                    League Settings
                  </button>
                </li>
              )}
            </ul>
            <p className="small muted">General Insights is available now, without setup.</p>
          </div>
        </section>
      </div>
    );
  }

  const tryMove = (c: CustomCard) => {
    dispatch({ type: 'scenario', scenario: { adds: [c.addId], drops: c.dropId ? [c.dropId] : [] } });
    onGoTrades();
  };
  const cards = result ? (all ? result.cards : result.cards.slice(0, CUSTOM_SHOWN)) : [];
  return (
    <div className="stack insights">
      <section className="panel" aria-label="Custom Insights">
        <div className="panel-head">
          <h2>Custom Insights</h2>
          <div className="segmented" role="group" aria-label="Insight period">
            <button aria-pressed={ctx === 'nextWeek'} onClick={() => setCtx('nextWeek')}>
              Next Week
            </button>
            <button aria-pressed={ctx === 'playoffs'} onClick={() => setCtx('playoffs')} disabled={!playoffDates.length}>
              Playoff Edge
            </button>
          </div>
        </div>
        <div className="panel-body insight-body">
          {!result && <DataNotice data={loaded} />}
          {result && (
            <>
              <p className="small muted insight-note">
                {ctx === 'nextWeek'
                  ? 'Moves that add the most to your lineup next week, in your scoring categories.'
                  : `Moves that add the most across your playoff rounds (${rounds.map((r) => r.name).join(', ')}), counting only roles that have lasted.`}{' '}
                Ownership is a guide only; check your league for availability.
              </p>
              {result.warnings.length > 0 && (
                <ul className="insight-warnings" aria-label="Roster notes">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {result.cards.length === 0 && <div className="empty">No move clears the bar right now. That’s a good sign for your roster.</div>}
              <div className="insight-cards">
                {cards.map((c) => (
                  <article key={c.addId} className="insight-card">
                    <div className="insight-title">
                      {c.headline} <span className="muted">{c.addTeam}</span>
                    </div>
                    <Lines lines={c.lines} />
                    <div className="insight-actions">
                      <button className="btn small" onClick={() => tryMove(c)}>
                        Try in Trade Lab
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {result.cards.length > CUSTOM_SHOWN && (
                <button className="btn small ghost" onClick={() => setAll(!all)}>
                  {all ? 'Show fewer' : `See all (${result.cards.length})`}
                </button>
              )}
              {result.goalieSchedule.length > 0 && (
                <section className="insight-group goalie-schedule" aria-label="Goalie Schedule">
                  <h3>Goalie Schedule</h3>
                  <Lines lines={result.goalieSchedule} />
                </section>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
