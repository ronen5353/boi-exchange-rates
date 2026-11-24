import { useState } from 'react';
import type { Rate } from './api';
import { convert, formatDate, groupThousands, type Direction } from './money';

export function Converter({ rates }: { rates: Rate[] }) {
  const [amount, setAmount] = useState('100');
  const [currency, setCurrency] = useState('USD');
  const [direction, setDirection] = useState<Direction>('toIls');

  const rate = rates.find((r) => r.currency === currency) ?? rates[0];
  if (!rate) return null;

  const [from, to] = direction === 'toIls' ? [rate.currency, 'ILS'] : ['ILS', rate.currency];
  const result = convert(amount, rate.rate, direction);
  const showError = amount.trim() !== '' && result === null;

  return (
    <section className="converter" aria-labelledby="converter-title">
      <h2 id="converter-title">Convert</h2>
      <div className="fields">
        <label>
          Amount in {from}
          <input
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={showError}
            aria-describedby={showError ? 'amount-error' : undefined}
          />
        </label>
        <label>
          Currency
          <select value={rate.currency} onChange={(e) => setCurrency(e.target.value)}>
            {rates.map((r) => (
              <option key={r.currency}>{r.currency}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setDirection(direction === 'toIls' ? 'fromIls' : 'toIls')}>
          Swap to {to} → {from}
        </button>
      </div>
      {showError && (
        <p id="amount-error" className="field-error">
          Enter a positive number such as 1250.50, up to 12 digits and 6 decimals.
        </p>
      )}
      <output aria-live="polite">{result === null ? '—' : `${groupThousands(result)} ${to}`}</output>
      <p className="note">
        1 {rate.currency} = {rate.rate} ILS, published {formatDate(rate.rateDate)}
        {rate.stale && ' (may be out of date)'}
      </p>
    </section>
  );
}
