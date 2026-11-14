import type { ReactNode } from 'react';

export function Kpi({ label, value, sub, bad }: { label: string; value: ReactNode; sub?: ReactNode; bad?: boolean }) {
  return (
    <div className="kpi">
      <div className="lbl">{label}</div>
      <div className={`val num${bad ? ' bad' : ''}`}>{value}</div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </div>
  );
}
