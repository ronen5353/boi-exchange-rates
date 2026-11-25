import { describe, expect, it } from 'vitest';
import { convert, formatDate, formatTime, groupThousands } from '../src/money';

describe('convert', () => {
  it('converts in both directions', () => {
    expect(convert('100', '3.343', 'toIls')).toBe('334.30');
    expect(convert('334.30', '3.343', 'fromIls')).toBe('100.00');
  });

  it('rounds half up where floats would get it wrong', () => {
    // As floats: (1.005 * 1).toFixed(2) === '1.00'
    expect(convert('1.005', '1', 'toIls')).toBe('1.01');
  });

  it('stays exact for large amounts', () => {
    expect(convert('999999999999.99', '4.3785', 'toIls')).toBe('4378499999999.96');
  });

  it.each(['', ' ', 'abc', '-5', '1e5', '1,000', '1.2.3', '.', 'Infinity', '1234567890123'])(
    'rejects %j',
    (input) => {
      expect(convert(input, '3.343', 'toIls')).toBeNull();
    },
  );
});

it('groups thousands', () => {
  expect(groupThousands('1234567.89')).toBe('1,234,567.89');
  expect(groupThousands('123.45')).toBe('123.45');
});

it('formats the date without shifting the day', () => {
  expect(formatDate('2026-11-23')).toBe('23 Nov 2026');
});

it('formats a time in Israel', () => {
  expect(formatTime('2026-11-24T22:03:00.000Z')).toBe('25 Nov, 00:03');
});
