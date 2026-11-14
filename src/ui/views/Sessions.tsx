import { useApi, type SessionSummary } from '../api';
import { Private, useMask } from '../components/HideTextToggle';
import { Kpi } from '../components/Kpi';
import { rangeWords } from '../components/RangeControl';
import { Tile } from '../components/Tile';
import { count, minutes, money, plural, tokens, when } from '../format';
import { href } from '../router';
import { LoadState, ViewHead, type ViewProps } from './ViewHead';

/** Last folder of a project path, for the tile subtitle. */
const folder = (p: string | null): string | null => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : null);

export function Sessions({ range, onRange, selected }: ViewProps) {
  const { data, error, loading } = useApi<SessionSummary[]>('sessions');
  const mask = useMask();
  const list = data ?? [];
  const total = list.reduce((s, x) => s + x.cost, 0);
  const priciest = [...list].sort((a, b) => b.cost - a.cost)[0];
  const compactions = list.reduce((s, x) => s + x.compactions, 0);
  const words = rangeWords(range);
  const lede = !data ? 'Every Claude Code session.' : list.length === 0 ? `No sessions ${words}.` : (
    <>{plural(list.length, 'session')} cost <b className="num">{money(total)}</b> {words}.
      {priciest && <> The most expensive was <b>{mask(priciest.title, 'an untitled session')}</b> at <b className="num">{money(priciest.cost)}</b>.</>}</>
  );
  return (
    <>
      <ViewHead title="Sessions" lede={lede} fine="Costs at API list prices, main thread plus the agents it launched."
        range={range} onRange={onRange} />
      <LoadState error={error} loading={loading && !data} />
      {data && (
        <>
          <div className="kpis">
            <Kpi label="Sessions" value={count(list.length)} />
            <Kpi label="Spend" value={money(total)} sub={`${money(list.reduce((s, x) => s + x.agentCost, 0))} in agents`} />
            <Kpi label="Average per session" value={list.length ? money(total / list.length) : '—'} />
            <Kpi label="Compactions" value={count(compactions)} sub="context summarised to fit" />
          </div>
          <div className="section">
            <div className="sec-h"><h2>Sessions</h2><span>newest first · click for detail</span></div>
            {list.length === 0 ? <p className="chart-empty">No sessions {words}.</p> : (
              <div className="tiles">
                {list.map((s) => {
                  const main = Math.max(0, s.cost - s.agentCost);
                  return (
                    <Tile key={s.id} to={href('sessions', s.id)} selected={selected === s.id}>
                      <div className="tile-top">
                        <span className="tile-name"><Private text={s.title} fallback="Untitled session" /></span>
                        {s.compactions > 0 && <span className="chip">{plural(s.compactions, 'compaction')}</span>}
                      </div>
                      <div className="tile-cost num">{money(s.cost)}</div>
                      <div className="tile-meta">
                        <span>{when(s.start)}</span>
                        <span><Private text={folder(s.project)} fallback="no project" /></span>
                      </div>
                      <div className="tile-meta">
                        <span><b className="num">{minutes(s.durationMin)}</b></span>
                        <span><b className="num">{count(s.calls)}</b> calls</span>
                        <span><b className="num">{tokens(s.peakCtx)}</b> peak ctx</span>
                      </div>
                      <div className="share" title={`${money(main)} main thread, ${money(s.agentCost)} agents`} aria-hidden="true">
                        <i style={{ width: `${s.cost > 0 ? (main / s.cost) * 100 : 0}%` }} />
                        <i style={{ width: `${s.cost > 0 ? (s.agentCost / s.cost) * 100 : 0}%` }} />
                      </div>
                    </Tile>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
