import { parse as parseCsv } from 'csv-parse/sync';
import { Decimal } from 'decimal.js';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { normalizeRate, REQUIRED_CURRENCIES, toIsraelDate, type Rate } from '../domain/rates.js';

/** The upstream answered, but with something we refuse to serve. */
export class InvalidUpstreamDataError extends Error {
  override name = 'InvalidUpstreamDataError';
}

export interface ParsedRates {
  rates: Rate[];
  /** Optional currencies that were dropped because their data was invalid. */
  rejected: string[];
}

// abort: the refine below must not run on text that isn't a number.
const decimalString = z
  .string()
  .max(64, { abort: true })
  .regex(/^-?\d+(\.\d+)?([eE][+-]?\d{1,2})?$/, { abort: true });
const positiveDecimal = decimalString.refine((v) => new Decimal(v).gt(0), 'must be positive');

const EnvelopeSchema = z.object({
  exchangeRates: z.array(z.looseObject({ key: z.string().regex(/^[A-Z]{3}$/) })).min(1),
});

const ItemSchema = z.object({
  key: z.string(),
  currentExchangeRate: positiveDecimal,
  currentChange: decimalString,
  unit: z.enum(['1', '10', '100', '1000']).transform(Number),
  lastUpdate: z.iso.datetime(),
});

const SdmxRowSchema = z.object({
  BASE_CURRENCY: z.enum(REQUIRED_CURRENCIES),
  COUNTER_CURRENCY: z.literal('ILS'),
  UNIT_MULT: z.literal('0'),
  TIME_PERIOD: z.iso.date(),
  OBS_VALUE: positiveDecimal,
});

// <Cube><Cube time="..."><Cube currency="..." rate="..."/>...</Cube></Cube>
const EcbSchema = z.object({
  'gesmes:Envelope': z.object({
    Cube: z.object({
      Cube: z.object({
        time: z.iso.date(),
        Cube: z.array(z.object({ currency: z.string(), rate: z.string() })),
      }),
    }),
  }),
});

function assertNoDuplicates(currencies: string[]): void {
  if (new Set(currencies).size !== currencies.length) {
    throw new InvalidUpstreamDataError('Duplicate currencies in upstream response');
  }
}

function assertRequiredPresent(rates: Rate[]): void {
  const missing = REQUIRED_CURRENCIES.filter((c) => !rates.some((r) => r.currency === c));
  if (missing.length > 0) {
    throw new InvalidUpstreamDataError(`Missing or invalid required currencies: ${missing.join(', ')}`);
  }
}

/** Keeps each JSON number as its original text, so it never becomes a float. */
function parseJsonWithExactNumbers(body: string): unknown {
  // `context.source` is newer than the TypeScript typings of JSON.parse.
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? context!.source : value;
  try {
    return JSON.parse(body, reviver as (key: string, value: unknown) => unknown);
  } catch {
    throw new InvalidUpstreamDataError('Upstream response is not valid JSON');
  }
}

export function parseBoiResponse(body: string): ParsedRates {
  const envelope = EnvelopeSchema.safeParse(parseJsonWithExactNumbers(body));
  if (!envelope.success) {
    throw new InvalidUpstreamDataError(`Unexpected response shape: ${envelope.error.message}`);
  }
  const items = envelope.data.exchangeRates;
  assertNoDuplicates(items.map((i) => i.key));

  const rates: Rate[] = [];
  const rejected: string[] = [];
  for (const raw of items) {
    const item = ItemSchema.safeParse(raw);
    if (!item.success) {
      // One bad minor currency must not take USD down; required ones are checked below.
      rejected.push(raw.key);
      continue;
    }
    const { key, currentExchangeRate, currentChange, unit, lastUpdate } = item.data;
    rates.push({
      currency: key,
      rate: normalizeRate(currentExchangeRate, unit),
      officialRate: new Decimal(currentExchangeRate).toFixed(),
      unit,
      changePercent: new Decimal(currentChange).toDecimalPlaces(4).toFixed(),
      rateDate: toIsraelDate(lastUpdate),
      lastUpdate,
      source: 'boi',
    });
  }
  assertRequiredPresent(rates);
  return { rates, rejected };
}

export function parseSdmxResponse(body: string): ParsedRates {
  let records: unknown;
  try {
    records = parseCsv(body, { columns: true, skip_empty_lines: true, bom: true });
  } catch {
    throw new InvalidUpstreamDataError('SDMX response is not valid CSV');
  }
  const rows = z.array(SdmxRowSchema).safeParse(records);
  if (!rows.success) {
    throw new InvalidUpstreamDataError(`Unexpected SDMX shape: ${rows.error.message}`);
  }
  assertNoDuplicates(rows.data.map((r) => r.BASE_CURRENCY));

  const rates = rows.data.map((row): Rate => {
    const value = new Decimal(row.OBS_VALUE).toFixed();
    return {
      currency: row.BASE_CURRENCY,
      rate: value,
      officialRate: value,
      unit: 1,
      changePercent: null,
      rateDate: row.TIME_PERIOD,
      lastUpdate: null,
      source: 'boi-sdmx',
    };
  });
  assertRequiredPresent(rates);
  return { rates, rejected: [] };
}

/** ECB publishes units of each currency per 1 EUR, so ILS rates are calculated as cross rates. */
export function parseEcbResponse(body: string): ParsedRates {
  let document: unknown;
  try {
    // Attribute values stay strings by default, so rates never become floats.
    document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(body, true);
  } catch {
    throw new InvalidUpstreamDataError('ECB response is not valid XML');
  }
  const parsed = EcbSchema.safeParse(document);
  if (!parsed.success) throw new InvalidUpstreamDataError(`Unexpected ECB shape: ${parsed.error.message}`);
  const { time, Cube: entries } = parsed.data['gesmes:Envelope'].Cube.Cube;
  assertNoDuplicates(entries.map((e) => e.currency));

  const perEuro = (currency: string): string => {
    const value = positiveDecimal.safeParse(entries.find((e) => e.currency === currency)?.rate);
    if (!value.success) throw new InvalidUpstreamDataError(`Missing or invalid ECB rate: ${currency}`);
    return value.data;
  };
  const ils = perEuro('ILS');

  const toRate = (currency: string, unitsPerEuro: string): Rate => {
    // 4 decimals, like BOI's rates.
    const value = new Decimal(ils).div(unitsPerEuro).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (!value.gt(0)) throw new InvalidUpstreamDataError(`ECB rate of ${currency} is too small`);
    return {
      currency,
      rate: value.toFixed(),
      officialRate: value.toFixed(),
      unit: 1,
      changePercent: null,
      rateDate: time,
      lastUpdate: null,
      source: 'ecb',
    };
  };
  return {
    rates: [toRate('USD', perEuro('USD')), toRate('EUR', '1'), toRate('GBP', perEuro('GBP'))],
    rejected: [],
  };
}
