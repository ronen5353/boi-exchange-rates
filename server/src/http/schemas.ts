import { z } from 'zod';

const RateSchema = z.object({
  currency: z.string(),
  rate: z.string().describe('ILS per 1 unit of the currency (decimal string)'),
  officialRate: z.string().describe('ILS per `unit`, as published'),
  unit: z.number().int(),
  changePercent: z.string().nullable(),
  rateDate: z.string().describe('Publication date in Israel, YYYY-MM-DD'),
  lastUpdate: z.string().nullable(),
  source: z.enum(['boi', 'boi-sdmx', 'ecb']),
  fetchedAt: z.string(),
  status: z
    .enum(['fresh', 'stale', 'backup'])
    .describe('stale: last known BOI rate, still within its time limit. backup: not a BOI rate'),
  stale: z.boolean().describe('True unless the status is fresh'),
});

const RatesResponse = z.object({
  base: z.literal('ILS'),
  stale: z.boolean().describe('True if any rate is stale'),
  rates: z.array(RateSchema),
});

const ConversionResponse = z.object({
  conversionId: z.string().describe('Identifies this conversion in the logs'),
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  result: z.string().describe('Rounded half up to the decimals of the currency'),
  rate: RateSchema,
});

const RateResponse = RateSchema.extend({ base: z.literal('ILS') });

const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const StatusResponse = z.object({
  hasData: z.boolean(),
  stale: z.boolean(),
  held: z.array(z.string()).describe('Currencies with an unconfirmed change'),
  onBackup: z.array(z.string()).describe('Currencies served from ECB'),
  unavailable: z.array(z.object({ currency: z.string(), reason: z.enum(['expired', 'held', 'missing']) })),
  backupReady: z.boolean(),
  lastSuccessAt: z.string().nullable().describe('Last successful BOI refresh'),
  lastSource: z.enum(['boi', 'boi-sdmx', 'ecb']).nullable(),
  storage: z.enum(['disabled', 'unknown', 'ok', 'error']),
});

const HealthResponse = z.object({ status: z.literal('ok'), rates: StatusResponse });

const toJson = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7' });

export const ratesResponse = toJson(RatesResponse);
export const rateResponse = toJson(RateResponse);
export const conversionResponse = toJson(ConversionResponse);
export const errorResponse = toJson(ErrorResponse);
export const statusResponse = toJson(StatusResponse);
export const healthResponse = toJson(HealthResponse);
