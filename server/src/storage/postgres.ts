import pg from 'pg';
import type { RateSource, StoredRate } from '../domain/rates.js';
import type { RateStore } from './store.js';

// One row per published value, so the table is also the history of every rate we served.
// Confirming the same value again only moves confirmed_at.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rates (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    currency       text NOT NULL,
    rate           numeric NOT NULL CHECK (rate > 0),
    official_rate  numeric NOT NULL CHECK (official_rate > 0),
    unit           integer NOT NULL,
    change_percent numeric,
    rate_date      date NOT NULL,
    last_update    text,
    source         text NOT NULL,
    first_seen_at  timestamptz NOT NULL,
    confirmed_at   timestamptz NOT NULL,
    UNIQUE (currency, rate_date, source, rate, unit)
  )`;

// Arbitrary, but must be the same in every instance.
const SCHEMA_LOCK_ID = 727_001;

interface Row {
  currency: string;
  rate: string;
  official_rate: string;
  unit: number;
  change_percent: string | null;
  rate_date: string;
  last_update: string | null;
  source: RateSource;
  confirmed_at: Date;
}

export function createPostgresStore(url: string, onError: (err: Error) => void): RateStore {
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 2_000,
    query_timeout: 3_000,
  });
  // Without a listener, losing an idle connection would crash the process.
  pool.on('error', onError);

  let schemaReady = false;
  async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    // Likewise for a connection lost while we hold it; the query itself also rejects.
    client.on('error', onError);
    let broken = false;
    try {
      await client.query('BEGIN');
      if (!schemaReady) {
        // Instances starting together would otherwise race to create the table.
        await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
        await client.query(SCHEMA);
      }
      const result = await work(client);
      await client.query('COMMIT');
      schemaReady = true;
      return result;
    } catch (err) {
      // Closing the connection also rolls the transaction back.
      broken = true;
      throw err;
    } finally {
      client.off('error', onError);
      client.release(broken);
    }
  }

  return {
    load: () =>
      transaction(async (client) => {
        // rate_date::text, because the driver would turn a date into local midnight.
        const { rows } = await client.query<Row>(`
          SELECT DISTINCT ON (currency, source = 'ecb')
            currency, rate, official_rate, unit, change_percent,
            rate_date::text AS rate_date, last_update, source, confirmed_at
          FROM rates
          ORDER BY currency, source = 'ecb', rates.rate_date DESC, confirmed_at DESC, id DESC`);
        return rows.map(
          (row): StoredRate => ({
            currency: row.currency,
            rate: row.rate,
            officialRate: row.official_rate,
            unit: row.unit,
            changePercent: row.change_percent,
            rateDate: row.rate_date,
            lastUpdate: row.last_update,
            source: row.source,
            fetchedAt: row.confirmed_at.toISOString(),
          }),
        );
      }),

    save: (rates) =>
      transaction(async (client) => {
        // Always in the same order, so that concurrent instances can't deadlock.
        const ordered = [...rates].sort((a, b) => a.currency.localeCompare(b.currency));
        for (const r of ordered) {
          await client.query(
            `INSERT INTO rates (currency, rate, official_rate, unit, change_percent, rate_date,
                                last_update, source, first_seen_at, confirmed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
             ON CONFLICT (currency, rate_date, source, rate, unit) DO UPDATE SET
               confirmed_at = GREATEST(rates.confirmed_at, EXCLUDED.confirmed_at),
               change_percent = EXCLUDED.change_percent,
               last_update = EXCLUDED.last_update`,
            [r.currency, r.rate, r.officialRate, r.unit, r.changePercent, r.rateDate, r.lastUpdate, r.source, r.fetchedAt],
          );
        }
      }),

    close: () => pool.end(),
  };
}
