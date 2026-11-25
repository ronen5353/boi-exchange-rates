import type { Rate, Status } from './api';
import { Converter } from './Converter';
import { formatDate, formatTime } from './money';
import { StatusPanel } from './StatusPanel';
import { useRates } from './useRates';

const CURRENCIES = [
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
];

const SOURCES: Record<Rate['source'], string> = {
  boi: 'Bank of Israel',
  'boi-sdmx': 'Bank of Israel (SDMX)',
  ecb: 'European Central Bank',
};

type Reason = Status['unavailable'][number]['reason'];

const REASONS: Record<Reason, string> = {
  expired: 'Blocked: the last known rate is too old to use.',
  held: 'Blocked: an unusual change is waiting for confirmation.',
  missing: 'Rate currently unavailable',
};

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

interface RateCardProps {
  code: string;
  name: string;
  rate?: Rate;
  reason?: Reason;
}

function RateCard({ code, name, rate, reason = 'missing' }: RateCardProps) {
  return (
    <article className="card" aria-label={name}>
      <header>
        <h2>{code}</h2>
        <span>{name}</span>
        {rate?.stale && <span className="badge">{rate.status === 'backup' ? 'Backup' : 'Stale'}</span>}
      </header>
      {rate ? (
        <>
          <p className="rate">
            {rate.rate} <small>ILS</small>
          </p>
          <Change percent={rate.changePercent} />
          <p className="note">Published {formatDate(rate.rateDate)}</p>
          <p className="note">Source: {SOURCES[rate.source]}</p>
          <p className="note">
            {rate.status === 'backup' ? 'Received' : 'Confirmed'} {formatTime(rate.fetchedAt)}
          </p>
        </>
      ) : (
        <p className={reason === 'missing' ? 'note' : 'blocked'}>{REASONS[reason]}</p>
      )}
    </article>
  );
}

export function App() {
  const { rates, status, failed, loading, retry } = useRates();
  const find = (code: string) => rates?.find((r) => r.currency === code);
  const reason = (code: string) => status?.unavailable.find((u) => u.currency === code)?.reason;
  const shown = CURRENCIES.flatMap(({ code }) => find(code) ?? []);

  return (
    <main>
      <h1>Exchange rates</h1>
      <p className="note">Against the Israeli shekel</p>

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
          Some rates could not be confirmed by the Bank of Israel. Rates marked “Stale” are its last known ones.
          {shown.some((r) => r.status === 'backup') &&
            ' Rates marked “Backup” come from the European Central Bank.'}
        </div>
      )}
      {!rates && loading && !failed && <p role="status">Loading rates…</p>}

      {/* Without rates, the cards still explain why. */}
      {(rates || (failed && status)) && (
        <>
          <section className="cards" aria-label="Rates">
            {CURRENCIES.map(({ code, name }) => (
              <RateCard key={code} code={code} name={name} rate={find(code)} reason={reason(code)} />
            ))}
          </section>
          {shown.length > 0 && <Converter currencies={CURRENCIES.map((c) => c.code)} rates={shown} />}
        </>
      )}
      {status && <StatusPanel shown={shown} status={status} />}
    </main>
  );
}
