import type { CostParts, TokenParts } from './types';

/** $ per million tokens. */
export interface PriceRow {
  id: string;
  model: string;
  effectiveFrom: string;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  longContextOver?: number;
  longContextMultiplier?: number;
  fastMultiplier?: number;
}

const row = (
  model: string, input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number,
  extra: Partial<PriceRow> = {},
): PriceRow => ({
  id: `${model}@2026-01-01`, model, effectiveFrom: '2026-01-01', input, output, cacheWrite5m, cacheWrite1h,
  cacheRead, ...extra,
});

export const PRICES: PriceRow[] = [
  row('fable-5-2', 8, 40, 10, 16, 0.2, { fastMultiplier: 2 }),
  row('opus-5-5', 4, 20, 5, 8, 0.2, { fastMultiplier: 2 }),
  row('sonnet-5-5', 2, 10, 2.5, 4, 0.1),
  row('haiku-5-5', 0.1, 0.5, 0.125, 0.2, 0.01, { longContextOver: 100000, longContextMultiplier: 5 }),
];

const NONE = { cost: null, parts: null, priceId: null };

/** Price one call at API list prices; unknown or not-yet-effective models are unpriced (null). */
export function priceCall(
  model: string, tokens: TokenParts, at: string, speed: 'standard' | 'fast' = 'standard',
): { cost: number | null; parts: CostParts | null; priceId: string | null } {
  const atMs = Date.parse(at);
  let r: PriceRow | undefined;
  for (const p of PRICES) {
    if (p.model !== model || Date.parse(p.effectiveFrom) > atMs) continue;
    if (!r || Date.parse(p.effectiveFrom) > Date.parse(r.effectiveFrom)) r = p;
  }
  if (!r) return NONE;
  let m = speed === 'fast' && r.fastMultiplier ? r.fastMultiplier : 1;
  const prompt = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  if (r.longContextOver !== undefined && prompt > r.longContextOver) m *= r.longContextMultiplier ?? 1;
  const c = (n: number, rate: number) => (n * rate * m) / 1e6;
  const parts: CostParts = {
    input: c(tokens.input, r.input),
    cacheWrite5m: c(tokens.cacheWrite5m, r.cacheWrite5m),
    cacheWrite1h: c(tokens.cacheWrite1h, r.cacheWrite1h),
    cacheRead: c(tokens.cacheRead, r.cacheRead),
    output: c(tokens.output, r.output),
    thinking: c(tokens.thinking, r.output),
  };
  const cost = parts.input + parts.cacheWrite5m + parts.cacheWrite1h + parts.cacheRead + parts.output + parts.thinking;
  return { cost, parts, priceId: r.id };
}
