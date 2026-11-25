import { z } from 'zod';

const RateSchema = z.object({
  currency: z.string(),
  // Also guards the converter's division: zero is rejected.
  rate: z.string().regex(/^(?=.*[1-9])\d+(\.\d+)?$/),
  changePercent: z.string().nullable(),
  rateDate: z.iso.date(),
  source: z.enum(['boi', 'boi-sdmx', 'ecb']),
  fetchedAt: z.iso.datetime(),
  stale: z.boolean(),
  // Optional, because the UI and the API are deployed separately.
  status: z.enum(['fresh', 'stale', 'backup']).optional(),
});

const RatesSchema = z.object({ rates: z.array(RateSchema) });

const StatusSchema = z.object({
  unavailable: z.array(z.object({ currency: z.string(), reason: z.enum(['expired', 'held', 'missing']) })),
  held: z.array(z.string()),
  backupReady: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  storage: z.enum(['disabled', 'unknown', 'ok', 'error']),
});

const ErrorSchema = z.object({ error: z.object({ code: z.string() }) });

export type Rate = z.infer<typeof RateSchema>;
export type Status = z.infer<typeof StatusSchema>;

/** The API itself says that no rate may be used, unlike a network or gateway error. */
export class NoUsableRatesError extends Error {}

// Longer than the server's worst case, when its sources time out during startup.
const TIMEOUT_MS = 25_000;

function get(path: string, signal: AbortSignal): Promise<Response> {
  return fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
}

export async function fetchRates(signal: AbortSignal): Promise<Rate[]> {
  const response = await get('/api/rates', signal);
  if (!response.ok) {
    const error = ErrorSchema.safeParse(await response.json().catch(() => null));
    if (error.data?.error.code === 'NO_DATA') throw new NoUsableRatesError();
    throw new Error(`Rates request failed with HTTP ${response.status}`);
  }
  return RatesSchema.parse(await response.json()).rates;
}

/** The status only adds detail, so a failure must not hide the rates. */
export async function fetchStatus(signal: AbortSignal): Promise<Status | null> {
  try {
    const response = await get('/api/status', signal);
    return response.ok ? StatusSchema.parse(await response.json()) : null;
  } catch {
    return null;
  }
}
