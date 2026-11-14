import { describe, expect, it } from 'vitest';
import { fillDays } from '../../src/ui/views/Overview';

describe('daily spend days', () => {
  it('fills idle days with zero between recorded days', () => {
    const d = fillDays([{ day: '2026-11-10', cost: 1, parts: {} }, { day: '2026-11-13', cost: 2, parts: {} }],
      { from: '2026-11-10T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z' });
    expect(d.map((x) => x.cost)).toEqual([1, 0, 0, 2]);
  });

  it('week preset always covers seven local days ending today', () => {
    const d = fillDays([], { preset: 'week' });
    expect(d.length).toBe(7);
  });
});
