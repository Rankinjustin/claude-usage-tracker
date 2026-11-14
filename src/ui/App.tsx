import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataContext, subscribe, useApi, type Coverage, type Overview as OverviewData, type Range } from './api';
import { DetailPanel } from './components/DetailPanel';
import { backfillRunning, EmptyState, storeEmpty } from './components/EmptyState';
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

const TODAY: Range = { preset: 'today' };
const BACKFILL_POLL_MS = 3000;

export function App() {
  const [range, setRange] = useState<Range>({ preset: 'week' });
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(true);
  useEffect(() => subscribe(() => setTick((t) => t + 1), setLive), []);
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

  const empty = !!overview.data && !!coverage.data && overview.data.calls === 0
    && (storeEmpty(coverage.data) || running);
  const viewProps = { range, onRange: setRange, overview: overview.data, selected: route.id };
  return (
    <div className={`app${hasDetail ? (full ? ' has-detail full-detail' : ' has-detail') : ''}`}>
      <Sidebar view={route.view} overview={overview.data} todayTotal={today.data?.total ?? null}
        coverage={coverage.data} live={live} />
      <main className="main">
        {empty && coverage.data ? <EmptyState coverage={coverage.data} /> : (
          <>
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
