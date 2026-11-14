import { useEffect, useRef, type ReactNode } from 'react';
import { goBack, navigate } from '../router';

/**
 * Right-hand detail panel. Beside the tiles from 900px up; below that it slides over them with a scrim.
 * Back goes to where the user came from (or the parent route), close returns to the view, and the
 * full-page button lets the detail take the whole workspace.
 */
export function DetailPanel({ children, parent, viewHash, routeKey, full, onToggleFull }: {
  children: ReactNode; parent: string; viewHash: string; routeKey: string; full: boolean; onToggleFull: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') navigate(viewHash); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewHash]);
  // Back to the top when a different detail opens, not on live refreshes of the same one.
  useEffect(() => { ref.current?.scrollTo?.({ top: 0 }); }, [routeKey]);
  return (
    <>
      <button type="button" className="scrim" aria-label="Close detail" tabIndex={-1} onClick={() => navigate(viewHash)} />
      <aside className="detail" aria-label="Detail" ref={ref}>
        <div className="detail-bar">
          <button type="button" className="icon-btn" aria-label="Back" title="Back" onClick={() => goBack(parent)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-pressed={full} onClick={onToggleFull}
            title={full ? 'Show beside the list' : 'Open as full page'}>
            {full ? 'Side panel' : 'Full page'}
          </button>
          <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={() => navigate(viewHash)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="detail-body">{children}</div>
      </aside>
    </>
  );
}
