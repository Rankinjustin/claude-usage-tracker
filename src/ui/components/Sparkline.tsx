/** Small bar sparkline (one bar per run). Hot bars are drawn in the alert colour. */
export function Sparkline({ values, hot = [], label }: { values: number[]; hot?: boolean[]; label: string }) {
  const n = Math.max(values.length, 1);
  const max = Math.max(...values, 0);
  const W = 100, H = 28, gap = n > 1 ? Math.min(2, 40 / n) : 0;
  const bw = (W - gap * (n - 1)) / n;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = max > 0 ? Math.max(2, (v / max) * H) : 2;
        return (
          <rect key={i} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(1.5, bw / 3)}
            fill={hot[i] ? 'var(--serious)' : 'var(--s1)'} opacity={hot[i] ? 1 : 0.85} />
        );
      })}
    </svg>
  );
}
