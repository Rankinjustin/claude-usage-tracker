import { describe, expect, it } from 'vitest';
import { priceCall } from '../../src/core/prices';
import type { TokenParts } from '../../src/core/types';

const T = (p: Partial<TokenParts>): TokenParts => ({
  input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0, ...p,
});
const AT = '2026-06-01T00:00:00Z';

describe('priceCall', () => {
  it('opus 5.5 call matches reference screenshot', () => {
    const r = priceCall('opus-5-5',
      T({ input: 6, cacheWrite1h: 38580, cacheRead: 200107, output: 2207, thinking: 244 }), AT);
    expect(r.cost).toBeCloseTo(0.3977, 4);
    expect(r.parts!.cacheWrite1h).toBeCloseTo(0.3086, 4);
    expect(r.parts!.cacheRead).toBeCloseTo(0.04, 4);
    expect(r.priceId).toBe('opus-5-5@2026-01-01');
  });

  it('haiku 5.5 over 100K prompt bills 5x', () => {
    const tk = T({ input: 60000, cacheRead: 60000, output: 1000 });
    const big = priceCall('haiku-5-5', tk, AT);
    const small = priceCall('haiku-5-5', T({ input: 6, output: 1000 }), AT);
    expect(big.parts!.input).toBeCloseTo(60000 * 0.10 * 5 / 1e6, 8);
    expect(big.parts!.cacheRead).toBeCloseTo(60000 * 0.01 * 5 / 1e6, 8);
    expect(big.parts!.output).toBeCloseTo(1000 * 0.5 * 5 / 1e6, 8);
    expect(small.parts!.output).toBeCloseTo(1000 * 0.5 / 1e6, 8);
  });

  it('fast mode doubles opus 5.5 and fable 5.2', () => {
    const tk = T({ input: 1000, output: 1000 });
    for (const m of ['opus-5-5', 'fable-5-2']) {
      const a = priceCall(m, tk, AT, 'standard').cost!;
      const b = priceCall(m, tk, AT, 'fast').cost!;
      expect(b).toBeCloseTo(a * 2, 10);
    }
    const s = priceCall('sonnet-5-5', tk, AT, 'fast').cost!;
    expect(s).toBeCloseTo(priceCall('sonnet-5-5', tk, AT).cost!, 10);
  });

  it('unknown model returns null cost and null priceId', () => {
    expect(priceCall('mystery-1', T({ input: 5 }), AT)).toEqual({ cost: null, parts: null, priceId: null });
  });

  it('row chosen by effectiveFrom <= at', () => {
    expect(priceCall('opus-5-5', T({ input: 5 }), '2026-01-01T00:00:00Z').priceId).toBe('opus-5-5@2026-01-01');
    expect(priceCall('opus-5-5', T({ input: 5 }), '2025-12-31T23:59:59Z')).toEqual(
      { cost: null, parts: null, priceId: null });
  });
});
