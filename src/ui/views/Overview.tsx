import { useState } from 'react';
import { useApi, type Overview as OverviewData, type PromptRow } from '../api';
import { BarChart, ChartTip } from '../components/BarChart';
import { Private } from '../components/HideTextToggle';
import { Kpi } from '../components/Kpi';
import { rangeWords } from '../components/RangeControl';
import { StackBar } from '../components/StackBar';
import { Tile } from '../components/Tile';
import { count, dayKey, money, pct, plural, slot, tokens, TOKEN_LABEL, when } from '../format';
import { href } from '../router';
import { LoadState, ViewHead, type ViewProps } from './ViewHead';

const TOP_PROMPTS = 6;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev <= 0) return <>no earlier period to compare</>;
  const d = ((now - prev) / prev) * 100;
  return <><span className={d > 0 ? 'delta-bad' : 'delta-good'}>{d > 0 ? '▲' : '▼'} {pct(Math.abs(d))}</span> vs the period before</>;
}

/** Day-of-week by hour grid; cell strength is spend. Tooltip stays inside the box. */
function Heatmap({ heat }: { heat: OverviewData['heat'] }) {
  const [lit, setLit] = useState<{ weekday: number; hour: number; cost: number } | null>(null);
  const W = 356, LEFT = 28, TOP = 4, cell = (W - LEFT) / 24, ch = 12, H = TOP + 7 * ch + 16;
  const max = Math.max(...heat.map((h) => h.cost), 0);
  if (max <= 0) return <p className="chart-empty">Nothing to show for this range.</p>;
  const at = new Map(heat.map((h) => [`${h.weekday}:${h.hour}`, h.cost]));
  return (
    <div className="chart heat">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" onMouseLeave={() => setLit(null)}
        aria-label={`Spend by day of week and hour; busiest ${DAYS[heat.reduce((m, h) => (h.cost > m.cost ? h : m)).weekday]}`}>
        {DAYS.map((d, w) => <text key={d} x="0" y={TOP + w * ch + 9}>{d}</text>)}
        {[0, 6, 12, 18].map((h) => <text key={h} x={LEFT + h * cell} y={H - 3}>{String(h).padStart(2, '0')}</text>)}
        {DAYS.map((_, w) => Array.from({ length: 24 }, (_, h) => {
          const c = at.get(`${w}:${h}`) ?? 0;
          return (
            <rect key={`${w}:${h}`} x={LEFT + h * cell + 0.5} y={TOP + w * ch + 0.5} width={cell - 1} height={ch - 1} rx="2"
              fill={c > 0 ? 'var(--accent)' : 'var(--surface-2)'} opacity={c > 0 ? 0.18 + 0.82 * (c / max) : 1}
              onMouseEnter={() => setLit(c > 0 ? { weekday: w, hour: h, cost: c } : null)} />
          );
        }))}
        {lit && <ChartTip x={LEFT + lit.hour * cell + cell / 2} y={TOP + lit.weekday * ch}
          title={`${DAYS[lit.weekday]} ${String(lit.hour).padStart(2, '0')}:00`} sub={money(lit.cost)} width={W} height={H} />}
      </svg>
    </div>
  );
}

export function Overview({ range, onRange, overview: o }: ViewProps) {
  const top = useApi<PromptRow[]>('prompts');
  const words = rangeWords(range);
  const prompts = [...(top.data ?? [])].sort((a, b) => b.total - a.total).slice(0, TOP_PROMPTS).filter((p) => p.total > 0);
  const fine = o && o.unpricedCalls > 0
    ? <>Costs at API list prices. <span className="warn">{plural(o.unpricedCalls, 'call')} on an unknown model {o.unpricedCalls === 1 ? 'is' : 'are'} unpriced</span> and left out of the totals.</>
    : 'Costs at API list prices.';
  return (
    <>
      <ViewHead title="Overview" range={range} onRange={onRange} fine={fine}
        lede={o ? <>You spent <b className="num">{money(o.total)}</b> {words}. {o.takeaway}</> : 'Your Claude Code spend at a glance.'} />
      <LoadState error={null} loading={!o} />
      {o && (
        <>
          <div className="kpis">
            <Kpi label="Spend" value={money(o.total)} sub={<Delta now={o.total} prev={o.prevTotal} />} />
            <Kpi label="Tokens" value={tokens(o.tokens)} sub={`${count(o.calls)} API calls`} />
            <Kpi label="Cache hit rate" value={pct(o.cacheHitPct)} sub="of input read from cache" />
            <Kpi label="Subagent share" value={pct(o.subagentPct)} sub={`main thread avg ${tokens(o.mainAvgCtx)} ctx`} />
          </div>
          <div className="section card">
            <div className="chart-h">Where it went <span>by token type</span></div>
            <StackBar label="Spend by token type" format={money}
              segments={o.parts.map((p, i) => ({ key: p.key, label: TOKEN_LABEL[p.key] ?? p.key, value: p.cost, color: slot(i + 1) }))} />
          </div>
          <div className="section grid-2">
            <div className="card">
              <div className="chart-h">Daily spend <span>local days</span></div>
              <BarChart label={`Daily spend, ${o.daily.length} days`} format={money}
                bars={o.daily.map((d) => ({ value: d.cost, tip: dayKey(d.day), tipSub: money(d.cost) }))}
                xLabels={o.daily.length ? [dayKey(o.daily[0]!.day), dayKey(o.daily[o.daily.length - 1]!.day)] : undefined} />
            </div>
            <div className="card">
              <div className="chart-h">When you spend <span>day × hour</span></div>
              <Heatmap heat={o.heat} />
            </div>
          </div>
          {prompts.length > 0 && (
            <div className="section">
              <div className="sec-h"><h2>Most expensive prompts</h2><span>click for detail</span></div>
              <div className="tiles">
                {prompts.map((p) => (
                  <Tile key={p.uuid} to={href('prompts', p.uuid)} selected={false}>
                    <div className="tile-cost num">{money(p.total)}</div>
                    <div className="tile-text"><Private text={p.text} /></div>
                    <div className="tile-meta">
                      <span className="num">{when(p.ts)}</span>
                      {p.agentCost > 0 && <span><b className="num">{money(p.agentCost)}</b> agents</span>}
                    </div>
                  </Tile>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
