import { createContext, useContext, useEffect, useState } from 'react';
import type { Range } from '../core/types';
import type { agentDetail, coverage, overview, promptDetail, sessionDetail } from '../query/views';

export type { Range };
export type { AgentStats, PromptRow, RunRow, SessionSummary } from '../query/views';
export type Overview = ReturnType<typeof overview>;
export type Coverage = ReturnType<typeof coverage> & { backfillProgress: BackfillProgress | null };
export type PromptDetailData = NonNullable<ReturnType<typeof promptDetail>>;
export type SessionDetailData = ReturnType<typeof sessionDetail>;
export type AgentDetailData = ReturnType<typeof agentDetail>;
export interface BackfillProgress { done: number; total: number; startedAt?: string; finishedAt?: string }

/** The `range` query value the server accepts. */
export function rangeParam(r: Range): string {
  return 'preset' in r ? r.preset : `${r.from},${r.to}`;
}

/** GET /api/<path> with the range appended. The server's HttpOnly cookie carries the key. */
export async function getJSON<T>(path: string, range: Range): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`/api/${path}${sep}range=${encodeURIComponent(rangeParam(range))}`,
    { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `Request failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * Listens to the server's change stream. Calls `onChange` with the changed session ids and `onStatus` when the
 * connection opens or drops (EventSource reconnects by itself). Returns the unsubscribe function.
 */
export function subscribe(onChange: (sessionIds: string[]) => void, onStatus?: (live: boolean) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource('/api/events');
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  es.onmessage = (e: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(e.data) as { changed?: unknown };
      if (Array.isArray(msg.changed)) onChange(msg.changed.map(String));
    } catch { /* heartbeat or malformed line */ }
  };
  return () => es.close();
}

/** Range and live-refresh counter shared by every view. */
export const DataContext = createContext<{ range: Range; tick: number }>({ range: { preset: 'week' }, tick: 0 });

export interface ApiState<T> { data: T | null; error: string | null; loading: boolean }

/**
 * Fetches `path` for the current range (or `opts.range`) and refetches on range change or live update. Keeps the previous data
 * while a refetch runs so the page doesn't flash. `path` null skips the fetch.
 */
export function useApi<T>(path: string | null, opts: { range?: Range } = {}): ApiState<T> {
  const ctx = useContext(DataContext);
  const range = opts.range ?? ctx.range;
  const tick = ctx.tick;
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: path !== null });
  const key = rangeParam(range);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    getJSON<T>(path, range).then(
      (data) => { if (live) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (live) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })); },
    );
    return () => { live = false; };
    // range is represented by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, tick]);
  // A path change means different data: don't show the old payload under the new id.
  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setState({ data: null, error: null, loading: path !== null });
  }
  return state;
}
