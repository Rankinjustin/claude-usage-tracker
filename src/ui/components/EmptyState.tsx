import type { Coverage } from '../api';
import { count } from '../format';

/** Same window as cli.ts BACKFILL_STALE_MS: an unfinished backfill older than this is treated as dead. */
export const BACKFILL_STALE_MS = 15 * 60 * 1000;

/**
 * True while the first-run backfill is reading old transcripts: started, not finished, and started less than
 * BACKFILL_STALE_MS ago (a backfill that died never writes finishedAt). Drives both the polling and the UI.
 */
export function backfillRunning(c: Coverage | null, now = Date.now()): boolean {
  const p = c?.backfillProgress;
  if (!p || p.finishedAt || !p.startedAt) return false;
  const age = now - Date.parse(p.startedAt);
  return age >= 0 && age < BACKFILL_STALE_MS;
}

function progressOf(c: Coverage): { done: number; total: number; pct: number } {
  const p = c.backfillProgress;
  const done = p?.done ?? 0, total = p?.total ?? 0;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/** Thin progress strip shown above a normal view while a backfill runs and some data is already in. */
export function BackfillBanner({ coverage }: { coverage: Coverage }) {
  const { done, total, pct } = progressOf(coverage);
  return (
    <div className="backfill-banner">
      <span>Reading your Claude Code history: <span className="num">{total > 0 ? `${count(done)} of ${count(total)} files` : 'finding transcript files'}</span>. Figures fill in as it goes.</span>
      <div className="progress" role="progressbar" aria-label="Transcript files indexed" aria-valuemin={0}
        aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** True when nothing has been recorded at all (as opposed to an empty range). */
export function storeEmpty(c: Coverage | null): boolean {
  return !!c && c.sessionsComplete + c.sessionsPartial === 0;
}

/** First-run screen: backfill progress while history is read, or a short note when there is nothing yet. */
export function EmptyState({ coverage }: { coverage: Coverage }) {
  const running = backfillRunning(coverage);
  const { done, total, pct: pctDone } = progressOf(coverage);
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
            <span className="num">{total > 0 ? `${count(done)} of ${count(total)} files` : 'Finding transcript files'}</span>
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
