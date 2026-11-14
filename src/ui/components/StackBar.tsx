export interface StackSegment { key: string; label: string; value: number; color: string; detail?: string }

/** One horizontal bar split by share, with a legend that carries the numbers. */
export function StackBar({ segments, label, format }: { segments: StackSegment[]; label: string; format: (v: number) => string }) {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <p className="chart-empty">Nothing to show for this range.</p>;
  let x = 0;
  const gap = 0.4;
  return (
    <div className="chart">
      <svg width="100%" height="14" viewBox="0 0 100 14" preserveAspectRatio="none" role="img"
        aria-label={`${label}: ${shown.map((s) => `${s.label} ${format(s.value)}`).join(', ')}`}>
        <defs><clipPath id={`clip-${label.replace(/\W/g, '')}`}><rect width="100" height="14" rx="7" /></clipPath></defs>
        <g clipPath={`url(#clip-${label.replace(/\W/g, '')})`}>
          {shown.map((s, i) => {
            const w = (s.value / total) * 100;
            const r = <rect key={s.key} x={x} y="0" width={Math.max(0, w - (i < shown.length - 1 ? gap : 0))} height="14" fill={s.color} />;
            x += w;
            return r;
          })}
        </g>
      </svg>
      <div className="stack-legend">
        {shown.map((s) => (
          <div key={s.key}>
            <i style={{ background: s.color }} />{s.label}
            <b className="num">{format(s.value)}</b>
            <em className="num">{Math.round((s.value / total) * 100)}%</em>
          </div>
        ))}
      </div>
    </div>
  );
}
