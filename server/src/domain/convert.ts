import { ExactDecimal } from './rates.js';

/** Decimal places of an amount. Currencies not listed here have 2. */
const DECIMALS: Record<string, number> = { JPY: 0, JOD: 3 };

export function decimalsOf(currency: string): number {
  return DECIMALS[currency] ?? 2;
}

/** A positive amount, without more decimals than the currency has. */
export function isValidAmount(amount: string, currency: string): boolean {
  if (!/^\d{1,12}(\.\d+)?$/.test(amount)) return false;
  const value = new ExactDecimal(amount);
  return value.gt(0) && value.decimalPlaces() <= decimalsOf(currency);
}

/** `rate` is ILS per 1 unit of the other currency. Rounds only the result, half up. */
export function convertAmount(amount: string, to: string, rate: string): string {
  const value = new ExactDecimal(amount);
  const result = to === 'ILS' ? value.mul(rate) : value.div(rate);
  return result.toFixed(decimalsOf(to), ExactDecimal.ROUND_HALF_UP);
}
