import { Decimal } from 'decimal.js';

/** A response missing any of these is unusable, whatever else it contains. */
export const REQUIRED_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

export const SUPPORTED_CURRENCIES: readonly string[] = [
  ...REQUIRED_CURRENCIES,
  'JPY', 'AUD', 'CAD', 'DKK', 'NOK', 'ZAR', 'SEK', 'CHF', 'JOD', 'LBP', 'EGP',
];

export type RateSource = 'boi' | 'boi-sdmx' | 'ecb';

/** One validated rate from an upstream source. Decimals are strings throughout. */
export interface Rate {
  currency: string;
  /** ILS per 1 unit of the currency. */
  rate: string;
  /** ILS per `unit`, as published (calculated from EUR rates when the source is ECB). */
  officialRate: string;
  unit: number;
  changePercent: string | null;
  /** Publication date in Israel, YYYY-MM-DD. */
  rateDate: string;
  lastUpdate: string | null;
  source: RateSource;
}

export interface StoredRate extends Rate {
  /** When the source last confirmed this rate. */
  fetchedAt: string;
}

export interface ServedRate extends StoredRate {
  /** `backup` is not a BOI rate. */
  status: 'fresh' | 'stale' | 'backup';
  /** True unless the status is `fresh`. */
  stale: boolean;
}

// Division rounds to `precision` digits; 100 is far more than any rate we accept.
export const ExactDecimal = Decimal.clone({ precision: 100 });

export function normalizeRate(officialRate: string, unit: number): string {
  // toFixed() without arguments keeps every digit and never uses exponent notation.
  return new ExactDecimal(officialRate).div(unit).toFixed();
}

const israelDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function toIsraelDate(timestamp: string): string {
  const parts = israelDate.formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
