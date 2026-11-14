import { useState } from 'react';

export interface Bar { value: number; tip: string; tipSub?: string; hot?: boolean; color?: string }

const W = 356;
const PAD_L = 34;
const PAD_T = 8;
const AXIS_H = 16;

/**
 * Tooltip drawn inside the SVG and clamped to its box, so it never spills out of the card or the panel.
 * `x`/`y` are the anchor point (top centre of the hovered mark).
 */
export function ChartTip({ x, y, title, sub, width, height }: { x: number; y: number; title: string; sub?: string; width: number; height: number }) {
  const tw = Math.min(width, Math.max(title.length * 6.3, (sub?.length ?? 0) * 6.2) + 16);
  const th = sub ? 34 : 20;
  const left = Math.min(Math.max(0, x - tw / 2), width - tw);
  const above = y - th - 6;
  const top = above >= 0 ? above : Math.min(height - th, y + 10);
  return (
    <g className="tip" pointerEvents="none" transform={`translate(${left},${top})`}>
      <rect width={tw} height={th} rx="6" />
      <text x="8" y="14">{title}</text>
      {sub && <text className="tip-sub" x="8" y="28">{sub}</text>}
    </g>
  );
}

/**
 * Vertical bar chart with a zero baseline, two gridlines, optional dashed reference line (e.g. the median)
 * and first/last x labels. Bars are focusable; hover or focus shows the tooltip; `onSelect` makes them clickable.
 */
export function BarChart({ bars, label, format, height = 120, reference, referenceLabel, xLabels, onSelect }: {
  bars: Bar[]; label: string; format: (v: number) => string; height?: number;
  reference?: number; referenceLabel?: string; xLabels?: [string, string]; onSelect?: (i: number) => void;
}) {
  const [lit, setLit] = useState<number | null>(null);
  if (bars.length === 0) return <p className="chart-empty">Nothing to show for this range.</p>;
  const H = height;
  const base = H - AXIS_H - 4;
  const max = Math.max(...bars.map((b) => b.value), reference ?? 0) || 1;
  const y = (v: number): number => base - (v / max) * (base - PAD_T);
  const slot = (W - PAD_L) / bars.length;
  const bw = Math.max(1, Math.min(14, slot * 0.7));
  const cx = (i: number): number => PAD_L + slot * i + slot / 2;
  const litBar = lit === null ? null : bars[lit];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} onMouseLeave={() => setLit(null)}>
        <line x1={PAD_L - 4} x2={W} y1={base} y2={base} stroke="var(--line-strong)" />
        <line x1={PAD_L - 4} x2={W} y1={PAD_T} y2={PAD_T} stroke="var(--line)" />
        <line x1={PAD_L - 4} x2={W} y1={(base + PAD_T) / 2} y2={(base + PAD_T) / 2} stroke="var(--line)" />
        <text x="0" y={PAD_T + 3}>{format(max)}</text>
        <text x="0" y={(base + PAD_T) / 2 + 3}>{format(max / 2)}</text>
        <text x="0" y={base + 3}>{format(0)}</text>
        {bars.map((b, i) => {
          const top = Math.min(y(b.value), base - 1.5);
          return (
            <rect key={i} className={`bar${onSelect ? ' click' : ''}${lit === i ? ' lit' : ''}`}
              x={cx(i) - bw / 2} y={top} width={bw} height={base - top} rx={Math.min(2, bw / 3)}
              fill={b.hot ? 'var(--serious)' : (b.color ?? 'var(--s1)')}
              tabIndex={0} aria-label={`${b.tip}${b.tipSub ? `, ${b.tipSub}` : ''}`}
              onMouseEnter={() => setLit(i)} onFocus={() => setLit(i)} onBlur={() => setLit(null)}
              onClick={onSelect ? () => onSelect(i) : undefined}
              onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } } : undefined} />
          );
        })}
        {reference !== undefined && reference > 0 && (
          <line x1={PAD_L - 4} x2={W} y1={y(reference)} y2={y(reference)} stroke="var(--ink-3)" strokeDasharray="3 3"
            aria-label={referenceLabel} />
        )}
        {xLabels && (
          <>
            <text x={PAD_L} y={H - 3}>{xLabels[0]}</text>
            <text x={W} y={H - 3} textAnchor="end">{xLabels[1]}</text>
          </>
        )}
        {litBar && lit !== null && (
          <ChartTip x={cx(lit)} y={y(litBar.value)} title={litBar.tip} sub={litBar.tipSub} width={W} height={H} />
        )}
      </svg>
    </div>
  );
}
