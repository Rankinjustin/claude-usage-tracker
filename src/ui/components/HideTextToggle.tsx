import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

const KEY = 'tt.hideText';
export const MASK = '•••';

const HideTextContext = createContext<{ hidden: boolean; toggle: () => void }>({ hidden: false, toggle: () => {} });

function readStored(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function HideTextProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(readStored);
  const toggle = useCallback(() => setHidden((h) => {
    try { localStorage.setItem(KEY, h ? '0' : '1'); } catch { /* storage blocked: keep it for this page only */ }
    return !h;
  }), []);
  return <HideTextContext.Provider value={{ hidden, toggle }}>{children}</HideTextContext.Provider>;
}

export function useHidden(): boolean {
  return useContext(HideTextContext).hidden;
}

/** Returns a function that masks prompt text, titles and paths while hide-text is on. */
export function useMask(): (text: string | null | undefined, fallback?: string) => string {
  const { hidden } = useContext(HideTextContext);
  return (text, fallback = '') => (hidden ? MASK : (text ?? fallback));
}

/** Prompt text, session titles, run descriptions and file paths go through this. */
export function Private({ text, fallback = '' }: { text: string | null | undefined; fallback?: string }) {
  const mask = useMask();
  return <>{mask(text, fallback)}</>;
}

export function HideTextToggle() {
  const { hidden, toggle } = useContext(HideTextContext);
  return (
    <button type="button" className="pill-btn" aria-pressed={hidden} onClick={toggle}
      title="Mask prompt text and file paths for screenshots">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        {hidden
          ? <><path d="M3 3l18 18" /><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.2M6.5 7.6C4.3 9.2 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 3.4-.7" /></>
          : <><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.5" /></>}
      </svg>
      {hidden ? 'Text hidden' : 'Hide text'}
    </button>
  );
}
