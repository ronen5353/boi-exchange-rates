import { useState } from 'react';
import type { Rate } from './api';
import { convert, formatDate, groupThousands, isValidAmount, type Direction } from './money';

export function Converter({ currencies, rates }: { currencies: string[]; rates: Rate[] }) {
  const [amount, setAmount] = useState('100');
  const [currency, setCurrency] = useState('USD');
  const [direction, setDirection] = useState<Direction>('toIls');

  // Without a rate the selection stays: switching currency silently could mislead.
  const rate = rates.find((r) => r.currency === currency);
  const [from, to] = direction === 'toIls' ? [currency, 'ILS'] : ['ILS', currency];
  const result = rate ? convert(amount, rate.rate, direction) : null;
  const showError = amount.trim() !== '' && !isValidAmount(amount);

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
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((code) => (
              <option key={code}>{code}</option>
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
      {rate ? (
        <p className="note">
          1 {currency} = {rate.rate} ILS, published {formatDate(rate.rateDate)}
          {rate.status === 'backup' ? ' by the European Central Bank' : rate.stale && ' (may be out of date)'}
        </p>
      ) : (
        <p className="blocked">{currency} can't be converted right now.</p>
      )}
    </section>
  );
}
