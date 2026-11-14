import { useApi, type AgentStats } from '../api';
import { Kpi } from '../components/Kpi';
import { rangeWords } from '../components/RangeControl';
import { Sparkline } from '../components/Sparkline';
import { Tile } from '../components/Tile';
import { count, money, pct, plural, tokens } from '../format';
import { href } from '../router';
import { LoadState, ViewHead, type ViewProps } from './ViewHead';

const FLAG_MULTIPLE = 3;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Marks sparkline runs far above the series' own median (the server flags against full history). */
function hotRuns(a: AgentStats): boolean[] {
  if (a.flaggedRuns === 0) return a.sparkline.map(() => false);
  const med = median(a.sparkline);
  return a.sparkline.map((v) => med > 0 && v > FLAG_MULTIPLE * med);
}

export function Agents({ range, onRange, overview, selected }: ViewProps) {
  const { data, error, loading } = useApi<AgentStats[]>('agents');
  // The main thread is not a subagent: leave it out of the tiles and re-base the shares on subagent spend.
  const agents = (data ?? []).filter((a) => a.type !== 'main');
  const spend = agents.reduce((s, a) => s + a.cost, 0);
  const runs = agents.reduce((s, a) => s + a.runs, 0);
  const flagged = agents.reduce((s, a) => s + a.flaggedRuns, 0);
  const cheapest = agents.filter((a) => a.runs > 0).sort((a, b) => a.perRun - b.perRun)[0];
  const top = agents[0];
  const words = rangeWords(range);
  const lede = !data ? 'Subagent and skill spend.' : agents.length === 0 ? `No subagent runs ${words}.` : (
    <>Subagents cost <b className="num">{money(spend)}</b> {words}
      {overview && overview.total > 0 && <>, <b>{pct(overview.subagentPct)}</b> of all spend</>}.
      {top && spend > 0 && <> <b>{top.type}</b> accounts for {pct((top.cost / spend) * 100)} of it.</>}</>
  );
  return (
    <>
      <ViewHead title="Agents & skills" lede={lede} fine="Costs at API list prices." range={range} onRange={onRange} />
      <LoadState error={error} loading={loading && !data} />
      {data && (
        <>
          <div className="kpis">
            <Kpi label="Subagent spend" value={money(spend)} sub={overview ? `${pct(overview.subagentPct)} of all spend` : undefined} />
            <Kpi label="Agent runs" value={count(runs)} sub={plural(agents.length, 'agent type')} />
            <Kpi label="Cheapest per run" value={cheapest ? money(cheapest.perRun) : '—'} sub={cheapest?.type ?? 'no runs yet'} />
            <Kpi label="Flagged runs" value={count(flagged)} bad={flagged > 0} sub={`over ${FLAG_MULTIPLE}× their usual cost`} />
          </div>
          <div className="section">
            <div className="sec-h"><h2>Agents</h2><span>sorted by spend · click for detail</span></div>
            {agents.length === 0 ? <p className="chart-empty">No subagents ran {words}.</p> : (
              <div className="tiles">
                {agents.map((a) => (
                  <Tile key={a.type} to={href('agents', a.type)} selected={selected === a.type}>
                    <div className="tile-top">
                      <span className="tile-name">{a.type}</span><span className="chip">{a.kind}</span>
                      {a.flaggedRuns > 0 && <span className="flag">▲ {plural(a.flaggedRuns, 'run')}</span>}
                    </div>
                    <div className="tile-cost num">{money(a.cost)}</div>
                    <Sparkline values={a.sparkline} hot={hotRuns(a)} label={`Cost of the last ${a.sparkline.length} ${a.type} runs`} />
                    <div className="tile-meta">
                      <span><b className="num">{count(a.runs)}</b> {a.runs === 1 ? 'run' : 'runs'}</span>
                      <span><b className="num">{money(a.perRun)}</b>/run</span>
                      <span><b className="num">{tokens(a.avgCtx)}</b> ctx</span>
                    </div>
                    <div className="share" aria-hidden="true"><i style={{ width: `${spend > 0 ? (a.cost / spend) * 100 : 0}%` }} /></div>
                  </Tile>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
