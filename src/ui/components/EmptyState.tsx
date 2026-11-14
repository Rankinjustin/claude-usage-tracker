import type { Coverage } from '../api';
import { count } from '../format';

/** True while the first-run backfill is reading old transcripts. */
export function backfillRunning(c: Coverage | null): boolean {
  const p = c?.backfillProgress;
  return !!p && !p.finishedAt;
}

/** True when nothing has been recorded at all (as opposed to an empty range). */
export function storeEmpty(c: Coverage | null): boolean {
  return !!c && c.sessionsComplete + c.sessionsPartial === 0;
}

/** First-run screen: backfill progress while history is read, or a short note when there is nothing yet. */
export function EmptyState({ coverage }: { coverage: Coverage }) {
  const p = coverage.backfillProgress;
  const running = backfillRunning(coverage);
  const pctDone = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const filled = Math.round(pctDone / 12.5);
  return (
    <section className="empty" aria-labelledby="empty-h">
      <div className="empty-art" aria-hidden="true">
        {[30, 48, 38, 64, 52, 40, 58, 44].map((h, i) => <i key={i} className={i < filled ? 'fill' : ''} style={{ height: `${h}px` }} />)}
      </div>
      {running ? (
        <>
          <h2 id="empty-h">Reading your Claude Code history</h2>
          <p>Token Tracker is going through the transcripts already on this machine. Figures appear here as each
            file is indexed; you can keep working in Claude Code meanwhile.</p>
          <div className="progress" role="progressbar" aria-label="Transcript files indexed" aria-valuemin={0}
            aria-valuemax={100} aria-valuenow={pctDone}>
            <i style={{ width: `${pctDone}%` }} />
          </div>
          <div className="progress-label">
            <span className="num">{p && p.total > 0 ? `${count(p.done)} of ${count(p.total)} files` : 'Finding transcript files'}</span>
            <span className="num">{pctDone}%</span>
          </div>
        </>
      ) : (
        <>
          <h2 id="empty-h">No sessions recorded yet</h2>
          <p>Start a Claude Code session and its spend shows up here as it runs. Recording continues even when
            this page is closed.</p>
        </>
      )}
    </section>
  );
}
