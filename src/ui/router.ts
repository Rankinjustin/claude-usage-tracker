import { useSyncExternalStore, type MouseEvent } from 'react';

export type ViewName = 'overview' | 'sessions' | 'prompts' | 'agents';
export const VIEWS: ViewName[] = ['overview', 'sessions', 'prompts', 'agents'];

/** `#view`, `#view/<id>` (detail) or `#view/<id>/<runId>` (a run inside that detail). */
export interface Route { view: ViewName; id: string | null; runId: string | null }

export function parseHash(hash: string): Route {
  const seg = hash.replace(/^#/, '').split('/').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const view = (VIEWS as string[]).includes(seg[0] ?? '') ? (seg[0] as ViewName) : 'overview';
  return { view, id: seg[1] || null, runId: seg[2] || null };
}

export function href(view: ViewName, id?: string | null, runId?: string | null): string {
  return '#' + [view, id, runId].filter((s): s is string => !!s).map(encodeURIComponent).join('/');
}

const listeners = new Set<() => void>();
let internalMoves = 0;

function notify(): void { for (const l of listeners) l(); }

if (typeof window !== 'undefined') window.addEventListener('hashchange', notify);

export function navigate(to: string): void {
  if (window.location.hash === to) return;
  internalMoves++;
  window.location.hash = to;
  notify();
}

/** Back arrow: history back when we navigated inside the app, else the given parent route. */
export function goBack(parent: string): void {
  if (internalMoves > 0) {
    internalMoves--;
    window.history.back();
  } else {
    navigate(parent);
  }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => window.location.hash,
  );
  return parseHash(hash);
}

/** Click handler for in-app links: plain clicks navigate, modified clicks keep browser behaviour. */
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute('href') ?? '#overview');
}
