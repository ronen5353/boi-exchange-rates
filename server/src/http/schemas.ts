import { z } from 'zod';

const RateSchema = z.object({
  currency: z.string(),
  rate: z.string().describe('ILS per 1 unit of the currency (decimal string)'),
  officialRate: z.string().describe('ILS per `unit`, as published'),
  unit: z.number().int(),
  changePercent: z.string().nullable(),
  rateDate: z.string().describe('Publication date in Israel, YYYY-MM-DD'),
  lastUpdate: z.string().nullable(),
  source: z.enum(['boi', 'boi-sdmx']),
  fetchedAt: z.string(),
  stale: z.boolean().describe('The latest refresh could not renew this rate'),
});

const RatesResponse = z.object({
  base: z.literal('ILS'),
  stale: z.boolean().describe('True if any rate is stale'),
  rates: z.array(RateSchema),
});

const RateResponse = RateSchema.extend({ base: z.literal('ILS') });

const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const HealthResponse = z.object({
  status: z.literal('ok'),
  rates: z.object({
    hasData: z.boolean(),
    stale: z.boolean(),
    lastSuccessAt: z.string().nullable(),
    lastSource: z.enum(['boi', 'boi-sdmx']).nullable(),
  }),
});

const toJson = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7' });

export const ratesResponse = toJson(RatesResponse);
export const rateResponse = toJson(RateResponse);
export const errorResponse = toJson(ErrorResponse);
export const healthResponse = toJson(HealthResponse);
