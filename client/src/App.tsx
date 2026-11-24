import type { Rate } from './api';
import { Converter } from './Converter';
import { formatDate } from './money';
import { useRates } from './useRates';

const CURRENCIES = [
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
];

function Change({ percent }: { percent: string | null }) {
  if (percent === null) return <p className="change">Daily change unavailable</p>;
  const isDown = percent.startsWith('-');
  const isZero = Number(percent) === 0;
  const arrow = isZero ? '' : isDown ? '▼ ' : '▲ ';
  return (
    <p className={`change ${isZero ? '' : isDown ? 'down' : 'up'}`}>
      {arrow}
      {/* Display only, so a float is fine here. */}
      {Number(percent).toFixed(2)}%
    </p>
  );
}

function RateCard({ code, name, rate }: { code: string; name: string; rate?: Rate }) {
  return (
    <article className="card" aria-label={name}>
      <header>
        <h2>{code}</h2>
        <span>{name}</span>
        {rate?.stale && <span className="badge">Stale</span>}
      </header>
      {rate ? (
        <>
          <p className="rate">
            {rate.rate} <small>ILS</small>
          </p>
          <Change percent={rate.changePercent} />
          <p className="note">Published {formatDate(rate.rateDate)}</p>
        </>
      ) : (
        <p className="note">Rate currently unavailable</p>
      )}
    </article>
  );
}

export function App() {
  const { rates, failed, loading, retry } = useRates();
  const find = (code: string) => rates?.find((r) => r.currency === code);
  const shown = CURRENCIES.flatMap(({ code }) => find(code) ?? []);

  return (
    <main>
      <h1>Exchange rates</h1>
      <p className="note">Representative rates published by the Bank of Israel</p>

      {failed && (
        <div className="banner error" role="alert">
          <span>
            {rates
              ? 'Could not refresh. The rates below are from the last successful update.'
              : 'Exchange rates are unavailable right now.'}
          </span>
          <button type="button" onClick={retry} disabled={loading}>
            {loading ? 'Trying…' : 'Try again'}
          </button>
        </div>
      )}
      {!failed && shown.some((r) => r.stale) && (
        <div className="banner" role="status">
          The Bank of Israel could not be reached. Rates marked “Stale” are the last known ones.
        </div>
      )}
      {!rates && loading && !failed && <p role="status">Loading rates…</p>}

      {rates && (
        <>
          <section className="cards" aria-label="Rates">
            {CURRENCIES.map(({ code, name }) => (
              <RateCard key={code} code={code} name={name} rate={find(code)} />
            ))}
          </section>
          <Converter rates={shown} />
        </>
      )}
    </main>
  );
}
