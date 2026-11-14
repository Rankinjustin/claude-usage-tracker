import { useApi, type RunRow } from '../api';
import { Private } from '../components/HideTextToggle';
import { duration, money, plural, when } from '../format';
import { href, onLinkClick, type ViewName } from '../router';

/** Runs list shared by the prompt, session and agent details; each row opens that run. */
export function RunsTable({ runs, view, parentId, first = 'prompt' }: {
  runs: RunRow[]; view: ViewName; parentId: string; first?: 'prompt' | 'agent';
}) {
  if (runs.length === 0) return <p className="note">No agent runs.</p>;
  return (
    <table>
      <thead><tr><th>{first === 'prompt' ? 'Launched by prompt' : 'Agent'}</th><th className="r">Time</th><th className="r">Cost</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className={r.flagged ? 'hot' : undefined}>
            <td>
              <a href={href(view, parentId, r.id)} onClick={onLinkClick}>
                <span className="p">
                  {first === 'prompt'
                    ? <Private text={r.promptText ?? r.description} fallback="(no prompt)" />
                    : <>{r.agentType} · <Private text={r.description} fallback="run" /></>}
                </span>
              </a>
            </td>
            <td className="r num">{duration(r.durationMs)}</td>
            <td className="r num">{money(r.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One agent run, picked out of its parent detail's payload (prompt, session or agent type). */
export function RunDetail({ view, parentId, runId }: { view: ViewName; parentId: string; runId: string }) {
  const { data, error } = useApi<{ runs: RunRow[] }>(`${view}/${encodeURIComponent(parentId)}`);
  if (error) return <p className="error" role="alert">Couldn't load this run: {error}.</p>;
  if (!data) return <p className="loading">Loading…</p>;
  const run = data.runs.find((r) => r.id === runId);
  if (!run) return <p className="note">This run isn't in the selected range any more.</p>;
  return (
    <>
      <div className="d-head">
        <h3>{run.agentType}</h3>
        <p><Private text={run.description} fallback="Agent run" /></p>
        <p className="num">Started {when(run.start)}</p>
      </div>
      {run.flagged && (
        <div className="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></svg>
          <div><b>Flagged.</b> This run cost over 3× the usual for {run.agentType}.</div>
        </div>
      )}
      <div className="stats">
        <div><div className="lbl">Cost</div><div className="v num">{money(run.cost)}</div></div>
        <div><div className="lbl">API calls</div><div className="v num">{run.calls}</div></div>
        <div><div className="lbl">Duration</div><div className="v num">{duration(run.durationMs)}</div></div>
        <div><div className="lbl">Per call</div><div className="v num">{run.calls ? money(run.cost / run.calls) : '—'}</div></div>
      </div>
      {run.promptUuid && (
        <div>
          <div className="chart-h">Launched by</div>
          <a className="row" href={href('prompts', run.promptUuid)} onClick={onLinkClick}
            style={{ border: '1px solid var(--line)', borderRadius: 10 }}>
            <span className="row-text"><Private text={run.promptText} fallback="(prompt)" /></span>
            <span className="row-meta">Open the prompt · {plural(run.calls, 'call')} in this run</span>
          </a>
        </div>
      )}
    </>
  );
}
