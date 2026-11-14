/** Dollars: $137 for large amounts, $31.11 normally, $0.005 below a cent. */
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'unpriced';
  const a = Math.abs(v);
  if (a >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (a >= 100) return `$${v.toFixed(0)}`;
  if (a === 0) return '$0.00';
  if (a < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Token counts: 9.8M, 117K, 812. */
export function tokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

export const count = (v: number): string => v.toLocaleString('en-US');

export const pct = (v: number): string => `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;

/** Durations: 41m 12s, 2h 05m, 9s. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function minutes(min: number): string {
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

/** Local date and time: "Nov 12, 2:27 PM". */
export function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A YYYY-MM-DD local day key as "Nov 12". */
export function dayKey(k: string): string {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

export const TOKEN_LABEL: Record<string, string> = {
  input: 'Input', cacheWrite5m: 'Cache write 5m', cacheWrite1h: 'Cache write 1h', cacheRead: 'Cache read',
  output: 'Output', thinking: 'Thinking', advisor: 'Advisor',
};

/** Chart slot n (1-based) from the validated categorical palette. */
export const slot = (n: number): string => `var(--s${((n - 1) % 8) + 1})`;
