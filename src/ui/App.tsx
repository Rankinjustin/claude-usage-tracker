import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataContext, subscribe, useApi, type Coverage, type Overview as OverviewData, type Range } from './api';
import { DetailPanel } from './components/DetailPanel';
import { BackfillBanner, backfillRunning, EmptyState, storeEmpty } from './components/EmptyState';
import { HideTextProvider } from './components/HideTextToggle';
import { Sidebar } from './components/Sidebar';
import { AgentDetail } from './details/AgentDetail';
import { PromptDetail } from './details/PromptDetail';
import { RunDetail } from './details/RunDetail';
import { SessionDetail } from './details/SessionDetail';
import { href, useRoute, type Route } from './router';
import { Agents } from './views/Agents';
import { Overview } from './views/Overview';
import { Prompts } from './views/Prompts';
import { Sessions } from './views/Sessions';
import { ViewHead } from './views/ViewHead';

const TODAY: Range = { preset: 'today' };
const TITLES = { overview: 'Overview', sessions: 'Sessions', prompts: 'Prompts', agents: 'Agents & skills' } as const;
const BACKFILL_POLL_MS = 3000;
/** Live updates arriving within this window are coalesced into one refetch. */
const LIVE_COALESCE_MS = 1000;

export function App() {
  const [range, setRange] = useState<Range>({ preset: 'week' });
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(true);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsubscribe = subscribe(() => {
      if (pending.current) return;
      pending.current = setTimeout(() => { pending.current = null; setTick((t) => t + 1); }, LIVE_COALESCE_MS);
    }, setLive);
    return () => {
      unsubscribe();
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, []);
  const ctx = useMemo(() => ({ range, tick }), [range, tick]);
  const poll = useCallback(() => setTick((t) => t + 1), []);
  return (
    <DataContext.Provider value={ctx}>
      <HideTextProvider>
        <Shell range={range} setRange={setRange} live={live} poll={poll} />
      </HideTextProvider>
    </DataContext.Provider>
  );
}

function Shell({ range, setRange, live, poll }: { range: Range; setRange: (r: Range) => void; live: boolean; poll: () => void }) {
  const route = useRoute();
  const overview = useApi<OverviewData>('overview');
  const today = useApi<OverviewData>('overview', { range: TODAY });
  const coverage = useApi<Coverage>('coverage');
  const [full, setFull] = useState(false);
  const hasDetail = route.view !== 'overview' && route.id !== null;
  useEffect(() => { if (!hasDetail) setFull(false); }, [hasDetail]);

  const running = backfillRunning(coverage.data);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(poll, BACKFILL_POLL_MS);
    return () => clearInterval(t);
  }, [running, poll]);

  // Only an empty store replaces the view body; an empty range shows the normal view and its takeaway.
  const empty = storeEmpty(coverage.data) && !!overview.data && overview.data.calls === 0;
  const viewProps = { range, onRange: setRange, overview: overview.data, selected: route.id };
  return (
    <div className={`app${hasDetail ? (full ? ' has-detail full-detail' : ' has-detail') : ''}`}>
      <Sidebar view={route.view} overview={overview.data} todayTotal={today.data?.total ?? null}
        coverage={coverage.data} live={live} />
      <main className="main">
        {empty && coverage.data ? (
          <>
            <ViewHead title={TITLES[route.view]} lede="Nothing recorded yet." range={range} onRange={setRange} />
            <EmptyState coverage={coverage.data} />
          </>
        ) : (
          <>
            {running && coverage.data && <BackfillBanner coverage={coverage.data} />}
            {route.view === 'overview' && <Overview {...viewProps} />}
            {route.view === 'sessions' && <Sessions {...viewProps} />}
            {route.view === 'prompts' && <Prompts {...viewProps} />}
            {route.view === 'agents' && <Agents {...viewProps} />}
          </>
        )}
      </main>
      {hasDetail && (
        <DetailPanel parent={route.runId ? href(route.view, route.id) : href(route.view)} viewHash={href(route.view)}
          routeKey={href(route.view, route.id, route.runId)}
          full={full} onToggleFull={() => setFull((f) => !f)}>
          <Detail route={route} />
        </DetailPanel>
      )}
    </div>
  );
}

function Detail({ route }: { route: Route }) {
  const id = route.id!;
  if (route.runId) return <RunDetail view={route.view} parentId={id} runId={route.runId} />;
  if (route.view === 'prompts') return <PromptDetail uuid={id} />;
  if (route.view === 'sessions') return <SessionDetail id={id} />;
  return <AgentDetail type={id} />;
}
