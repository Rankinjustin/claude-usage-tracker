import { useState } from 'react';
import type { Range } from '../api';

const PRESETS = [['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All time']] as const;

/** Local midnight of a YYYY-MM-DD as an ISO instant, so day boundaries follow this machine's timezone. */
function localMidnight(day: string, addDays = 0): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d! + addDays).toISOString();
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today / Week / Month / All time / Custom. Custom takes two local dates, both inclusive. */
export function RangeControl({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const [custom, setCustom] = useState(!('preset' in range));
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const apply = (f: string, t: string): void => {
    if (f && t && f <= t) onChange({ from: localMidnight(f), to: localMidnight(t, 1) });
  };
  return (
    <div className="range">
      <div className="seg" role="group" aria-label="Time range">
        {PRESETS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={!custom && 'preset' in range && range.preset === key}
            onClick={() => { setCustom(false); onChange({ preset: key }); }}>{label}</button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => { setCustom(true); apply(from, to); }}>Custom</button>
      </div>
      {custom && (
        <div className="custom-range">
          <label>From <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); apply(e.target.value, to); }} /></label>
          <label>to <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); apply(from, e.target.value); }} /></label>
        </div>
      )}
    </div>
  );
}

export function rangeWords(r: Range): string {
  if (!('preset' in r)) return 'in this period';
  return { today: 'today', week: 'in the last 7 days', month: 'in the last 30 days', all: 'since install' }[r.preset];
}
