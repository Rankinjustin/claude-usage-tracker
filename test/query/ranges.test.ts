import { describe, expect, it } from 'vitest';
import { resolveRange } from '../../src/query/ranges';

describe('resolveRange', () => {
  it('today range uses local midnight', () => {
    process.env.TZ = 'America/Chicago'; // set at call time: ranges must not cache the zone
    const now = new Date('2026-11-13T06:30:00Z'); // 00:30 local (CST, UTC-6)
    const r = resolveRange({ preset: 'today' }, now);
    expect(r.from).toBe('2026-11-13T06:00:00.000Z');
    expect(r.to).toBe('2026-11-14T06:00:00.000Z');
    expect(r.prevFrom).toBe('2026-11-12T06:00:00.000Z');
    expect(r.prevTo).toBe(r.from);
    // 23:30 local the day before is still "yesterday", not today
    const late = resolveRange({ preset: 'today' }, new Date('2026-11-13T05:30:00Z'));
    expect(late.from).toBe('2026-11-12T06:00:00.000Z');
    // same module, new zone: Tokyo (UTC+9) midnight is 15:00Z the day before
    process.env.TZ = 'Asia/Tokyo';
    expect(resolveRange({ preset: 'today' }, now).from).toBe('2026-11-12T15:00:00.000Z');
  });

  it('week range is last 7 days incl. today', () => {
    process.env.TZ = 'America/Chicago';
    const r = resolveRange({ preset: 'week' }, new Date('2026-11-13T18:00:00Z'));
    expect(r.from).toBe('2026-11-07T06:00:00.000Z');
    expect(r.to).toBe('2026-11-14T06:00:00.000Z');
    expect(r.prevFrom).toBe('2026-10-31T05:00:00.000Z'); // CDT before the Nov 1 change
    expect(r.prevTo).toBe(r.from);
  });

  it('month, all and custom ranges', () => {
    process.env.TZ = 'America/Chicago';
    const now = new Date('2026-11-13T18:00:00Z');
    expect(resolveRange({ preset: 'month' }, now).from).toBe('2026-10-15T05:00:00.000Z');
    const all = resolveRange({ preset: 'all' }, now);
    expect(all.from).toBe('1970-01-01T00:00:00.000Z');
    expect(all.prevFrom).toBe(all.prevTo);
    const c = resolveRange({ from: '2026-11-10', to: '2026-11-12' }, now);
    expect(c.from).toBe('2026-11-10T06:00:00.000Z');
    expect(c.prevFrom).toBe('2026-11-08T06:00:00.000Z');
  });
});
