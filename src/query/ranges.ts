import type { Range } from '../core/types';

export interface ResolvedRange { from: string; to: string; prevFrom: string; prevTo: string }

/** Local midnight `offset` days from the day of `d`. Reads the machine timezone at call time. */
function dayStart(d: Date, offset = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
}

/** A bare YYYY-MM-DD means local midnight; anything else is parsed as an instant. */
function parseBound(s: string): Date {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
}

/**
 * Resolves a Range to [from, to) ISO instants plus the equally long period before it.
 * Presets are aligned to local midnight: today = 1 day, week = last 7 days incl. today,
 * month = last 30 days incl. today, all = everything (its previous period is empty).
 */
export function resolveRange(r: Range, now: Date = new Date()): ResolvedRange {
  const iso = (d: Date): string => d.toISOString();
  if ('preset' in r) {
    const days = { today: 1, week: 7, month: 30, all: 0 }[r.preset];
    const to = dayStart(now, 1);
    if (days === 0) {
      const from = '1970-01-01T00:00:00.000Z';
      return { from, to: iso(to), prevFrom: from, prevTo: from };
    }
    const from = dayStart(now, 1 - days);
    return { from: iso(from), to: iso(to), prevFrom: iso(dayStart(now, 1 - 2 * days)), prevTo: iso(from) };
  }
  const from = parseBound(r.from);
  const to = parseBound(r.to);
  const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  return { from: iso(from), to: iso(to), prevFrom: iso(prevFrom), prevTo: iso(from) };
}
