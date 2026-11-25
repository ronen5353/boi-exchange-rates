import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredRate } from '../src/domain/rates.js';
import { createPostgresStore } from '../src/storage/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const T1 = '2026-11-24T08:00:00.000Z';
const T2 = '2026-11-24T08:05:00.000Z';

const usd: StoredRate = {
  currency: 'USD',
  rate: '3.3430',
  officialRate: '3.3430',
  unit: 1,
  changePercent: '0.5111',
  rateDate: '2026-11-23',
  lastUpdate: '2026-11-23T13:21:10.7104898Z',
  source: 'boi',
  fetchedAt: T1,
};
const lbp: StoredRate = { ...usd, currency: 'LBP', rate: '0.00004', officialRate: '0.0004', unit: 10 };

// Needs a disposable database: the rates table is dropped.
describe.skipIf(!url)('Postgres store', () => {
  const admin = new pg.Pool({ connectionString: url });
  const open = () => createPostgresStore(url!, () => {});

  beforeEach(async () => {
    await admin.query('DROP TABLE IF EXISTS rates');
  });
  afterAll(() => admin.end());

  it('returns exactly what was saved, to another instance', async () => {
    const first = open();
    await first.save([usd, lbp]);
    await first.close();
    const second = open();
    expect(await second.load()).toEqual([
      lbp,
      usd,
    ]);
    await second.close();
  });

  it('keeps history, without a new row for an unchanged rate', async () => {
    const store = open();
    await store.save([usd]);
    await store.save([{ ...usd, fetchedAt: T2 }]);
    await store.save([{ ...usd, rate: '3.35', rateDate: '2026-11-24', fetchedAt: T2 }]);
    const { rows } = await admin.query('SELECT rate, first_seen_at, confirmed_at FROM rates ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0].first_seen_at.toISOString()).toBe(T1);
    expect(rows[0].confirmed_at.toISOString()).toBe(T2);
    expect((await store.load())[0]).toMatchObject({ rate: '3.35', rateDate: '2026-11-24' });
    await store.close();
  });

  it('keeps BOI and ECB rates apart', async () => {
    const store = open();
    const ecb: StoredRate = { ...usd, source: 'ecb', rate: '3.35', rateDate: '2026-11-24' };
    await store.save([usd, ecb]);
    expect(await store.load()).toEqual([usd, ecb]);
    await store.close();
  });

  it('saves all rates or none', async () => {
    const store = open();
    await expect(store.save([usd, { ...lbp, currency: 'ZZZ', rate: '-1' }])).rejects.toThrow();
    expect(await store.load()).toEqual([]);
    await store.close();
  });

  it('allows instances to start and save together', async () => {
    const stores = Array.from({ length: 5 }, open);
    await Promise.all(stores.map((s) => s.save([usd, lbp])));
    expect(await stores[0]!.load()).toHaveLength(2);
    await Promise.all(stores.map((s) => s.close()));
  });
});

it('fails instead of hanging when the database is unreachable', async () => {
  const store = createPostgresStore('postgres://x:x@127.0.0.1:9/x', () => {});
  await expect(store.load()).rejects.toThrow();
  await store.close();
});
