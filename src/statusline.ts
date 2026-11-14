import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './core/paths';
import type { Db } from './store/db';

export interface StatusParts {
  today: number | null;
  session: number | null;
  alerts: number;
  contextTokens: number | null;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** The single status line text. `today: null` renders `today —`. */
export function formatStatusLine(p: StatusParts): string {
  if (p.today === null && p.session === null && p.contextTokens === null) return '▮▮▮ Token Tracker';
  const out = [`▮▮▮ ${p.today === null ? 'today —' : `${money(p.today)} today`}`];
  if (p.session !== null) out.push(`session ${money(p.session)}`);
  if (p.contextTokens !== null) out.push(`context ${Math.round(p.contextTokens / 1000)}K`);
  if (p.alerts > 0) out.push(`▲ ${p.alerts} alert${p.alerts === 1 ? '' : 's'}`);
  return out.join(' · ');
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Builds the status line from Claude Code's stdin JSON and a read-only look at the db. Never writes, never throws. */
export async function statusLineText(stdin: Record<string, unknown>): Promise<string> {
  const sessionId = typeof stdin.session_id === 'string' ? stdin.session_id : null;
  const stdinCost = num(obj(stdin.cost).total_cost_usd);
  const cw = obj(stdin.context_window);
  const pct = num(cw.used_percentage);
  const size = num(cw.context_window_size);
  const contextTokens = pct !== null && size !== null ? (pct * size) / 100 : null;

  try {
    const path = dbPath();
    if (existsSync(path)) {
      const raw = new DatabaseSync(path, { readOnly: true });
      try {
        raw.exec('PRAGMA busy_timeout = 200');
        const { statusLine } = await import('./query/views');
        const s = statusLine({ raw } as Db, sessionId ?? '');
        let { today, session } = s;
        // The db learns the current session only at SessionEnd or while the server runs, so the in-flight part
        // comes from Claude Code's own cost estimate on stdin. If the session began before midnight, today
        // includes its pre-midnight share of that part.
        if (sessionId !== null && stdinCost !== null && stdinCost > s.session) {
          today += stdinCost - s.session;
          session = stdinCost;
        }
        return formatStatusLine({ today, session: sessionId === null ? null : session, alerts: s.alerts, contextTokens });
      } finally { raw.close(); }
    }
  } catch {
    // Missing, locked or mid-migration db: fall through to the stdin-only line.
  }
  return formatStatusLine({ today: null, session: stdinCost, alerts: 0, contextTokens });
}
