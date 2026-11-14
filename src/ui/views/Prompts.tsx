import { useEffect, useState } from 'react';
import { useApi, type PromptRow } from '../api';
import { Private } from '../components/HideTextToggle';
import { Kpi } from '../components/Kpi';
import { rangeWords } from '../components/RangeControl';
import { count, duration, money, plural, when } from '../format';
import { href, onLinkClick } from '../router';
import { LoadState, ViewHead, type ViewProps } from './ViewHead';

export const FLAG_MEDIAN = 3;
const SEARCH_DELAY_MS = 250;

function median(xs: number[]): number {
  const s = xs.filter((v) => v > 0).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function Prompts({ range, onRange, selected }: ViewProps) {
  const [q, setQ] = useState('');
  const [needle, setNeedle] = useState('');
  const [order, setOrder] = useState<'newest' | 'costliest'>('newest');
  useEffect(() => {
    const t = setTimeout(() => setNeedle(q.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading } = useApi<PromptRow[]>(needle ? `prompts?q=${encodeURIComponent(needle)}` : 'prompts');
  const list = [...(data ?? [])];
  if (order === 'costliest') list.sort((a, b) => b.total - a.total);
  const total = list.reduce((s, p) => s + p.total, 0);
  const priciest = list.reduce<PromptRow | null>((m, p) => (!m || p.total > m.total ? p : m), null);
  const flagged = list.filter((p) => (p.multipleOfMedian ?? 0) >= FLAG_MEDIAN).length;
  const words = rangeWords(range);
  const lede = !data ? 'Every prompt you sent, with what it cost.' : list.length === 0
    ? (needle ? `No prompts ${words} match “${needle}”.` : `No prompts ${words}.`)
    : <>{plural(list.length, 'prompt')}{needle ? ' match' : ''} {words}, <b className="num">{money(total)}</b> in all including the agents they launched.</>;
  return (
    <>
      <ViewHead title="Prompts" lede={lede} fine="Costs at API list prices, including spawned agents." range={range} onRange={onRange} />
      <LoadState error={error} loading={loading && !data} />
      <div className="kpis">
        <Kpi label="Prompts" value={count(list.length)} />
        <Kpi label="Median prompt" value={list.length ? money(median(list.map((p) => p.total))) : '—'} />
        <Kpi label="Priciest" value={priciest ? money(priciest.total) : '—'} sub={priciest ? when(priciest.ts) : undefined} />
        <Kpi label="Flagged" value={count(flagged)} bad={flagged > 0} sub={`${FLAG_MEDIAN}× your median or more`} />
      </div>
      <div className="section">
        <div className="sec-h">
          <input className="search" type="search" placeholder="Search prompt text" aria-label="Search prompt text"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mini-seg" role="group" aria-label="Order">
            <button type="button" aria-pressed={order === 'newest'} onClick={() => setOrder('newest')}>Newest</button>
            <button type="button" aria-pressed={order === 'costliest'} onClick={() => setOrder('costliest')}>Costliest</button>
          </div>
        </div>
        {list.length > 0 && (
          <div className="rows">
            {list.map((p) => (
              <a key={p.uuid} href={href('prompts', p.uuid)} className={`row${selected === p.uuid ? ' on' : ''}`}
                aria-current={selected === p.uuid ? 'true' : undefined} onClick={onLinkClick}>
                <span className="row-text"><Private text={p.text} /></span>
                <span className="row-cost num">{money(p.total)}
                  {p.agentCost > 0 && <small>{money(p.agentCost)} agents</small>}</span>
                <span className="row-meta">
                  <span className="num">{when(p.ts)}</span>
                  <span><Private text={p.sessionTitle} fallback="Untitled session" /></span>
                  <span className="num">{plural(p.calls, 'call')}</span>
                  {p.durationMs !== null && <span className="num">{duration(p.durationMs)}</span>}
                  {(p.multipleOfMedian ?? 0) >= FLAG_MEDIAN && <span className="flag">▲ {p.multipleOfMedian!.toFixed(1)}× median</span>}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
