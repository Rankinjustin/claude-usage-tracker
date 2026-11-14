import { useApi, type PromptDetailData } from '../api';
import { Private } from '../components/HideTextToggle';
import { count, duration, money, pct, plural, tokens, TOKEN_LABEL, when } from '../format';
import { href, onLinkClick } from '../router';
import { FLAG_MEDIAN } from '../views/Prompts';
import { RunsTable } from './RunDetail';

/**
 * Stage-1 prompt detail (mockup prompt-detail.html without the timeline and phases): header, summary strip,
 * cost by part and by token type, the runs it launched and the tools it used.
 */
export function PromptDetail({ uuid }: { uuid: string }) {
  const { data, error } = useApi<PromptDetailData>(`prompts/${encodeURIComponent(uuid)}`);
  if (error) return <p className="error" role="alert">Couldn't load this prompt: {error}.</p>;
  if (!data) return <p className="loading">Loading…</p>;
  const { prompt: p, summary: s, parts, byPart, runs, tools } = data;
  const total = s.cost + s.agentCost;
  const tokenRows = parts.filter((t) => t.tokens > 0 || t.cost > 0);
  return (
    <>
      <div className="crumb">
        <a href={href('sessions')} onClick={onLinkClick}>Sessions</a>›
        <a href={href('sessions', p.sessionId)} onClick={onLinkClick}><Private text={p.sessionTitle} fallback="Untitled session" /></a>›
        <span>Prompt</span>
      </div>
      <div className="d-head">
        <p className="prompt-text"><Private text={p.text} /></p>
        <div className="pmeta">
          <span className="num">{when(p.ts)}</span>
          {(p.multipleOfMedian ?? 0) >= FLAG_MEDIAN && <span className="pill warn">▲ {p.multipleOfMedian!.toFixed(1)}× your median prompt cost</span>}
          {runs.length > 0 && <span className="pill acc">{plural(runs.length, 'agent run')}</span>}
        </div>
      </div>
      <div className="stats">
        <div><div className="lbl">Total cost</div><div className="v big num" data-testid="prompt-total">{money(total)}</div>
          <div className="s num">{money(s.cost)} main + {money(s.agentCost)} agents</div></div>
        <div><div className="lbl">Wall time</div><div className="v big num">{duration(s.durationMs)}</div>
          <div className="s">until Claude finished</div></div>
        <div><div className="lbl">Tokens</div><div className="v big num">{tokens(s.tokens)}</div>
          <div className="s">{pct(s.cacheReadPct)} cache reads</div></div>
        <div><div className="lbl">API calls</div><div className="v big num">{count(s.apiCalls)}</div>
          <div className="s">{s.advisorCalls > 0 ? `+ ${plural(s.advisorCalls, 'advisor call')}` : 'no advisor calls'}</div></div>
        <div><div className="lbl">Tool calls</div><div className="v big num">{count(s.toolCalls)}</div>
          <div className={`s${s.failed + s.denied > 0 ? ' bad' : ''}`}>{s.failed} failed · {s.denied} denied</div></div>
      </div>
      <p className="note">Costs at API list prices.</p>
      <div className="d-grid">
        <div className="card">
          <div className="chart-h">What it cost, by part</div>
          <table>
            <thead><tr><th>Part</th><th>Share</th><th className="r">Cost</th></tr></thead>
            <tbody>
              {byPart.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td><span className="minibar"><i style={{ width: `${total > 0 ? (b.cost / total) * 100 : 0}%`,
                    background: b.label === 'Main thread' ? 'var(--s1)' : 'var(--s2)' }} /></span></td>
                  <td className="r num">{money(b.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Token type</th><th className="r">Tokens</th><th className="r">Cost</th></tr></thead>
            <tbody>
              {tokenRows.map((t) => (
                <tr key={t.key}><td>{TOKEN_LABEL[t.key] ?? t.key}</td><td className="r num">{tokens(t.tokens)}</td><td className="r num">{money(t.cost)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stack">
          <div className="card">
            <div className="chart-h">Agent runs <span>click to open</span></div>
            <RunsTable runs={runs} view="prompts" parentId={uuid} first="agent" />
          </div>
          <div className="card">
            <div className="chart-h">Tools <span>{plural(s.toolCalls, 'call')}</span></div>
            {tools.length === 0 ? <p className="note">No tool calls.</p> : (
              <table>
                <thead><tr><th>Tool</th><th className="r">Calls</th><th className="r">Failed</th></tr></thead>
                <tbody>
                  {tools.map((t) => (
                    <tr key={t.label} className={t.failed > 0 ? 'hot' : undefined}>
                      <td>{t.label}</td><td className="r num">{count(t.calls)}</td><td className="r num">{t.failed || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
