import { Decimal } from 'decimal.js';

export type Direction = 'toIls' | 'fromIls';

const AMOUNT = /^(\d{1,12}(\.\d{0,6})?|\.\d{1,6})$/;

export function isValidAmount(input: string): boolean {
  return AMOUNT.test(input.trim());
}

/** Rounds only the final result, half up, to 2 decimals. Returns null for an invalid amount. */
export function convert(input: string, rate: string, direction: Direction): string | null {
  if (!isValidAmount(input)) return null;
  const amount = new Decimal(input.trim());
  const result = direction === 'toIls' ? amount.mul(rate) : amount.div(rate);
  return result.toFixed(2, Decimal.ROUND_HALF_UP);
}

/** Adds thousands separators without converting the string to a float. */
export function groupThousands(value: string): string {
  const [whole = '', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** A timestamp in Israel time: "24 Nov, 17:03". */
export function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  }).format(new Date(timestamp));
}

/** "2026-11-23" -> "23 Nov 2026". UTC on both sides, so the day never shifts. */
export function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
