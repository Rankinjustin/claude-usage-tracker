import type { ReactNode } from 'react';
import type { Overview, Range } from '../api';
import { RangeControl } from '../components/RangeControl';

export interface ViewProps { range: Range; onRange: (r: Range) => void; overview: Overview | null; selected: string | null }

/** Title, one-sentence takeaway and the range control that open every view. */
export function ViewHead({ title, lede, fine, range, onRange }: {
  title: string; lede: ReactNode; fine?: ReactNode; range: Range; onRange: (r: Range) => void;
}) {
  return (
    <div className="head">
      <div>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        {fine && <p className="fineprint">{fine}</p>}
      </div>
      <RangeControl range={range} onChange={onRange} />
    </div>
  );
}

export function LoadState({ error, loading }: { error: string | null; loading: boolean }) {
  if (error) return <p className="error" role="alert">Couldn't load this view: {error}. It retries on the next update.</p>;
  if (loading) return <p className="loading">Loading…</p>;
  return null;
}
