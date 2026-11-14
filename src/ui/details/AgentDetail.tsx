import { useApi, type AgentDetailData } from '../api';
import { BarChart } from '../components/BarChart';
import { Private } from '../components/HideTextToggle';
import { day, duration, money, pct, plural } from '../format';
import { href, navigate } from '../router';
import { RunsTable } from './RunDetail';

const RECENT = 12;

/** One agent type: flagged-run alert, stats, cost per run against the median, recent runs. */
export function AgentDetail({ type }: { type: string }) {
  const { data, error } = useApi<AgentDetailData>(`agents/${encodeURIComponent(type)}`);
  if (error) return <p className="error" role="alert">Couldn't load this agent: {error}.</p>;
  if (!data) return <p className="loading">Loading…</p>;
  const { stats, runs, medianCost } = data;
  const worst = runs.filter((r) => r.flagged).sort((a, b) => b.cost - a.cost)[0];
  const recent = [...runs].reverse().slice(0, RECENT);
  return (
    <>
      <div className="d-head">
        <h3>{type}</h3>
        <p>{stats?.kind === 'custom' ? 'Custom agent' : stats?.kind === 'main' ? 'Main thread' : 'Built-in agent'}</p>
      </div>
      {worst && (
        <div className="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></svg>
          <div>
            <b>{stats && stats.flaggedRuns > 1 ? `${stats.flaggedRuns} runs cost over 3× their usual.` : `One run cost ${medianCost > 0 ? `${(worst.cost / medianCost).toFixed(1)}×` : 'well over'} its usual.`}</b>{' '}
            “<Private text={worst.description ?? worst.promptText} fallback="A run" />” cost {money(worst.cost)} over {duration(worst.durationMs)}.
            Usual run: {money(medianCost)}.
          </div>
        </div>
      )}
      <div className="stats">
        <div><div className="lbl">Runs</div><div className="v num">{stats?.runs ?? runs.length}</div></div>
        <div><div className="lbl">Avg cost / run</div><div className="v num">{stats ? money(stats.perRun) : '—'}</div></div>
        <div><div className="lbl">Avg duration</div><div className="v num">{stats ? duration(stats.avgDurationMs) : '—'}</div></div>
        <div><div className="lbl">Tool error rate</div><div className="v num">{stats ? pct(stats.errorRate) : '—'}</div></div>
      </div>
      <div>
        <div className="chart-h">Cost per run <span>dashed line = usual (median)</span></div>
        <BarChart label={`Cost per run for ${type}, ${plural(runs.length, 'run')}, median ${money(medianCost)}`} format={money}
          reference={medianCost} referenceLabel="median"
          bars={runs.map((r) => ({ value: r.cost, hot: r.flagged, tip: `${money(r.cost)} · ${duration(r.durationMs)}`, tipSub: day(r.start) }))}
          xLabels={runs.length ? [day(runs[0]!.start), day(runs[runs.length - 1]!.start)] : undefined}
          onSelect={(i) => navigate(href('agents', type, runs[i]!.id))} />
      </div>
      <div>
        <div className="chart-h">Recent runs</div>
        <RunsTable runs={recent} view="agents" parentId={type} />
      </div>
    </>
  );
}
