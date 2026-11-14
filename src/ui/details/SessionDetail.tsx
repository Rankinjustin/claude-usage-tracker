import { useApi, type SessionDetailData } from '../api';
import { BarChart } from '../components/BarChart';
import { Private } from '../components/HideTextToggle';
import { count, duration, minutes, money, plural, tokens, when } from '../format';
import { href, onLinkClick } from '../router';
import { RunsTable } from './RunDetail';

const MAX_CTX_BARS = 60;

/** Context size per main-thread call, thinned to at most MAX_CTX_BARS bars (keeping each bucket's peak). */
function thin(series: { ts: string; ctx: number }[]): { ts: string; ctx: number }[] {
  if (series.length <= MAX_CTX_BARS) return series;
  const size = Math.ceil(series.length / MAX_CTX_BARS);
  const out: { ts: string; ctx: number }[] = [];
  for (let i = 0; i < series.length; i += size) {
    out.push(series.slice(i, i + size).reduce((m, c) => (c.ctx > m.ctx ? c : m)));
  }
  return out;
}

/** One session: summary, context over time, its prompts and agent runs. */
export function SessionDetail({ id }: { id: string }) {
  const { data, error } = useApi<SessionDetailData>(`sessions/${encodeURIComponent(id)}`);
  if (error) return <p className="error" role="alert">Couldn't load this session: {error}.</p>;
  if (!data) return <p className="loading">Loading…</p>;
  const { session: s, prompts, runs, ctxSeries } = data;
  if (!s) return <p className="note">This session has no recorded calls.</p>;
  const ctx = thin(ctxSeries);
  return (
    <>
      <div className="d-head">
        <h3><Private text={s.title} fallback="Untitled session" /></h3>
        <p className="num">{when(s.start)} · {minutes(s.durationMin)}</p>
        <p><Private text={s.project} fallback="no project" /></p>
        <div className="d-chips">{s.models.map((m) => <span key={m} className="chip">{m}</span>)}</div>
      </div>
      <div className="stats">
        <div><div className="lbl">Cost</div><div className="v num">{money(s.cost)}</div>
          <div className="s num">{money(s.cost - s.agentCost)} main + {money(s.agentCost)} agents</div></div>
        <div><div className="lbl">API calls</div><div className="v num">{count(s.calls)}</div></div>
        <div><div className="lbl">Context</div><div className="v num">{tokens(s.peakCtx)}</div>
          <div className="s num">peak, started at {tokens(s.startCtx)}</div></div>
        <div><div className="lbl">Compactions</div><div className="v num">{s.compactions}</div></div>
      </div>
      <p className="note">Costs at API list prices.</p>
      <div>
        <div className="chart-h">Context size <span>main thread, per call</span></div>
        <BarChart label={`Context size over the session, peak ${tokens(s.peakCtx)} tokens`} format={tokens} height={110}
          bars={ctx.map((c) => ({ value: c.ctx, tip: `${tokens(c.ctx)} tokens`, tipSub: when(c.ts), color: 'var(--s3)' }))}
          xLabels={ctx.length ? [when(ctx[0]!.ts), when(ctx[ctx.length - 1]!.ts)] : undefined} />
      </div>
      <div>
        <div className="chart-h">Prompts <span>{plural(prompts.length, 'prompt')}</span></div>
        {prompts.length === 0 ? <p className="note">No prompts recorded.</p> : (
          <table>
            <thead><tr><th>Prompt</th><th className="r">Time</th><th className="r">Cost</th></tr></thead>
            <tbody>
              {prompts.map((p) => (
                <tr key={p.uuid}>
                  <td><a href={href('prompts', p.uuid)} onClick={onLinkClick}><span className="p"><Private text={p.text} /></span></a></td>
                  <td className="r num">{duration(p.durationMs)}</td>
                  <td className="r num">{money(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <div className="chart-h">Agent runs</div>
        <RunsTable runs={runs} view="sessions" parentId={id} first="agent" />
      </div>
    </>
  );
}
