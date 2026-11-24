import { z } from 'zod';

const RateSchema = z.object({
  currency: z.string(),
  // Also guards the converter's division: zero is rejected.
  rate: z.string().regex(/^(?=.*[1-9])\d+(\.\d+)?$/),
  changePercent: z.string().nullable(),
  rateDate: z.iso.date(),
  stale: z.boolean(),
});

const RatesSchema = z.object({ rates: z.array(RateSchema) });

export type Rate = z.infer<typeof RateSchema>;

// Longer than the server's worst case, when both of its sources time out.
const TIMEOUT_MS = 25_000;

export async function fetchRates(signal: AbortSignal): Promise<Rate[]> {
  const response = await fetch('/api/rates', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!response.ok) throw new Error(`Rates request failed with HTTP ${response.status}`);
  return RatesSchema.parse(await response.json()).rates;
}
