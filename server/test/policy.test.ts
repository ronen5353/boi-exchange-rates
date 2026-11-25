import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InvalidUpstreamDataError, parseEcbResponse } from '../src/boi/schema.js';
import { loadConfig } from '../src/config.js';
import type { StoredRate } from '../src/domain/rates.js';
import { boiBody, boiItem, boiItems, csv, ecbBody, fakeUpstream, json, sdmxBody, status, xml } from './helpers.js';

const HOUR = 3_600_000;
const down = async () => status(503);
// Published on the day after the first rate.
const D24 = '2026-11-24T06:00:00Z';

let closeApp: () => Promise<unknown> = async () => {};
afterEach(() => closeApp());

async function setup(stored: StoredRate[] = []) {
  const upstream = fakeUpstream();
  upstream.handlers.ecb = async () => xml(ecbBody());
  let time = Date.parse('2026-11-24T08:00:00Z');
  const { app, service } = await buildApp(loadConfig({ LOG_LEVEL: 'silent', UPSTREAM_ATTEMPTS: '1' }), {
    fetchFn: upstream.fetchFn,
    now: () => time,
    store: { load: async () => stored, save: async () => {}, close: async () => {} },
  });
  closeApp = () => app.close();
  const get = async (url: string) => {
    const res = await app.inject(url);
    return { code: res.statusCode, body: res.json() };
  };
  return {
    ...upstream,
    get,
    usd: () => get('/api/rates/USD'),
    refresh: () => service.refresh(),
    advance: (ms: number) => (time += ms),
    boiDown: () => {
      upstream.handlers.boi = down;
      upstream.handlers.sdmx = down;
    },
    /** BOI publishes this USD rate, with the other rates unchanged. */
    boiUsd: (rate: number, lastUpdate?: string) => {
      upstream.handlers.boi = async () => json(boiBody([boiItem('USD', rate, 1, lastUpdate), ...boiItems().slice(1)]));
    },
    sdmxUsd: (rate: string, date?: string) => {
      upstream.handlers.sdmx = async () => csv(sdmxBody(date).replace('3.35', rate));
    },
  };
}

const stored = (extra: Partial<StoredRate>): StoredRate => ({
  currency: 'USD',
  rate: '3.343',
  officialRate: '3.343',
  unit: 1,
  changePercent: null,
  rateDate: '2026-11-23',
  lastUpdate: null,
  source: 'boi',
  fetchedAt: '2026-11-24T07:00:00.000Z',
  ...extra,
});

describe('parseEcbResponse', () => {
  it('calculates rates in ILS', () => {
    const { rates } = parseEcbResponse(ecbBody());
    expect(Object.fromEntries(rates.map((r) => [r.currency, r.rate]))).toEqual({
      EUR: '3.6643',
      USD: '3.3498',
      GBP: '4.3793',
    });
  });

  it.each([
    ['empty', ''],
    ['cut off', ecbBody().slice(0, 300)],
    ['HTML', '<html><body>blocked</body></html>'],
    ['missing ILS', ecbBody().replace("'ILS'", "'XXX'")],
    ['duplicate currency', ecbBody().replace("'HKD'", "'USD'")],
    ['invalid date', ecbBody('yesterday')],
    ['zero', ecbBody('2026-11-23', '0')],
    ['not a number', ecbBody('2026-11-23', 'N/A')],
  ])('rejects: %s', (_name, body) => {
    expect(() => parseEcbResponse(body)).toThrow(InvalidUpstreamDataError);
  });
});

describe('time limits', () => {
  it('uses a saved BOI rate for 24 hours, then ECB', async () => {
    const t = await setup();
    await t.refresh();
    t.boiDown();
    t.advance(24 * HOUR);
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.343', status: 'stale', source: 'boi' });
    t.advance(1);
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup', source: 'ecb', stale: true });
    expect((await t.get('/health')).body.rates.onBackup).toEqual(['USD', 'EUR', 'GBP']);
  });

  it('blocks an expired currency that has no backup, and leaves it out of the list', async () => {
    const t = await setup();
    await t.refresh();
    t.boiDown();
    t.advance(24 * HOUR + 1);
    await t.refresh();
    expect(await t.get('/api/rates/JPY')).toMatchObject({ code: 503, body: { error: { code: 'RATE_EXPIRED' } } });
    const currencies = (await t.get('/api/rates')).body.rates.map((r: StoredRate) => r.currency);
    expect(currencies).toEqual(['USD', 'EUR', 'GBP']);
  });

  it('blocks everything once ECB is more than 4 days old', async () => {
    const t = await setup();
    await t.refresh();
    t.boiDown();
    t.handlers.ecb = down;
    t.advance(3 * 24 * HOUR);
    expect((await t.usd()).body.status).toBe('backup');
    t.advance(24 * HOUR);
    expect(await t.usd()).toMatchObject({ code: 503, body: { error: { code: 'RATE_EXPIRED' } } });
    expect((await t.get('/api/rates')).code).toBe(503);
  });

  it('uses ECB on a first start while BOI is down, and BOI once it returns', async () => {
    const t = await setup();
    t.boiDown();
    expect((await t.usd()).body.status).toBe('backup');
    t.handlers.boi = async () => json();
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.343', status: 'fresh' });
  });

  it('restores ECB rates separately from BOI rates', async () => {
    const t = await setup([stored({}), stored({ source: 'ecb', rate: '3.35' })]);
    t.boiDown();
    t.handlers.ecb = down;
    expect((await t.usd()).body).toMatchObject({ rate: '3.343', status: 'stale' });
    t.advance(24 * HOUR);
    expect((await t.usd()).body).toMatchObject({ rate: '3.35', status: 'backup' });
  });

  it('does not call ECB on every refresh', async () => {
    const t = await setup();
    await t.refresh();
    await t.refresh();
    expect(t.calls.ecb).toBe(1);
  });

  it('does not wait long for a slow ECB on a first start', async () => {
    const t = await setup();
    let finish = (_: Response) => {};
    t.handlers.ecb = () => new Promise((resolve) => (finish = resolve));
    expect((await t.usd()).body.status).toBe('fresh');
    finish(xml(ecbBody()));
  });

  it('does not let an ECB failure affect BOI rates', async () => {
    const t = await setup();
    t.handlers.ecb = down;
    expect((await t.usd()).body.status).toBe('fresh');
  });
});

describe('GET /api/status', () => {
  it('explains which currencies are unavailable', async () => {
    const t = await setup();
    await t.refresh();
    expect((await t.get('/api/status')).body).toMatchObject({ unavailable: [], backupReady: true, storage: 'ok' });
    t.boiDown();
    t.advance(24 * HOUR + 1);
    await t.refresh();
    const { code, body } = await t.get('/api/status');
    expect(code).toBe(200);
    expect(body).toMatchObject({
      onBackup: ['USD', 'EUR', 'GBP'],
      unavailable: [
        { currency: 'JPY', reason: 'expired' },
        { currency: 'LBP', reason: 'expired' },
      ],
    });
  });

  it('lists the required currencies when there is no data', async () => {
    const t = await setup();
    t.boiDown();
    t.handlers.ecb = down;
    await t.refresh();
    expect((await t.get('/api/status')).body).toMatchObject({
      hasData: false,
      backupReady: false,
      unavailable: [{ currency: 'USD' }, { currency: 'EUR' }, { currency: 'GBP' }],
    });
  });
});

describe('both BOI sources wrong', () => {
  const bothWrong = (t: Awaited<ReturnType<typeof setup>>) => {
    t.boiUsd(33.43);
    t.sdmxUsd('33.43');
  };

  it('uses ECB when it contradicts them', async () => {
    const t = await setup();
    await t.refresh();
    bothWrong(t);
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
    expect((await t.get('/api/rates/EUR')).body.status).toBe('fresh');
  });

  it('uses ECB on a first start too', async () => {
    const t = await setup();
    bothWrong(t);
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
  });

  it('finds the mistake when ECB publishes later', async () => {
    const t = await setup();
    t.handlers.ecb = async () => xml(ecbBody('2026-11-20'));
    await t.refresh();
    bothWrong(t);
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '33.43', status: 'fresh' });
    t.handlers.ecb = async () => xml(ecbBody());
    t.advance(HOUR);
    await t.refresh();
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
  });

  it('recovers when BOI corrects the rate', async () => {
    const t = await setup();
    await t.refresh();
    bothWrong(t);
    await t.refresh();
    t.handlers.boi = async () => json();
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.343', status: 'fresh', source: 'boi' });
  });

  it('does not accept a repeated mistake while ECB contradicts it', async () => {
    const t = await setup();
    await t.refresh();
    bothWrong(t);
    await t.refresh();
    t.advance(24 * HOUR);
    t.boiUsd(33.5, D24);
    t.sdmxUsd('33.5', '2026-11-24');
    t.handlers.ecb = async () => xml(ecbBody('2026-11-24'));
    await t.refresh();
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
  });
});

describe('unusual changes', () => {
  it('accepts a small change without asking another source', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.5, D24);
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.5', status: 'fresh' });
    expect(t.calls.sdmx).toBe(0);
  });

  it('accepts a large change that SDMX confirms', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.7, D24);
    t.sdmxUsd('3.7', '2026-11-24');
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.7', status: 'fresh', source: 'boi' });
  });

  it('accepts a large change that ECB confirms', async () => {
    const t = await setup();
    await t.refresh();
    t.advance(HOUR);
    t.boiUsd(3.7, D24);
    t.handlers.sdmx = down;
    t.handlers.ecb = async () => xml(ecbBody('2026-11-24', '0.99'));
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.7', status: 'fresh' });
  });

  it('uses SDMX when it contradicts the change', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(33.43);
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.35', status: 'fresh', source: 'boi-sdmx' });
  });

  it('holds a change nobody can confirm, without blocking other currencies', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.7, D24);
    t.handlers.sdmx = down;
    await t.refresh();
    expect(await t.usd()).toMatchObject({ code: 503, body: { error: { code: 'RATE_HELD' } } });
    expect((await t.get('/api/rates/EUR')).body.status).toBe('fresh');
    expect((await t.get('/health')).body.rates.held).toEqual(['USD']);
  });

  it('does not treat an older SDMX rate as a contradiction', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.7, D24);
    await t.refresh();
    expect((await t.usd()).body.error.code).toBe('RATE_HELD');
  });

  it('serves ECB during a hold once ECB is as recent as the change', async () => {
    const t = await setup();
    await t.refresh();
    t.advance(HOUR);
    t.boiUsd(3.7, D24);
    t.handlers.sdmx = down;
    t.handlers.ecb = async () => xml(ecbBody('2026-11-24'));
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
  });

  it('releases the hold when BOI corrects the rate', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.7, D24);
    t.handlers.sdmx = down;
    await t.refresh();
    t.boiUsd(3.36, D24);
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.36', status: 'fresh' });
  });

  it('keeps the hold when only an older normal rate is available', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.7, D24);
    t.handlers.sdmx = down;
    await t.refresh();
    t.handlers.boi = down;
    t.sdmxUsd('3.343', '2026-11-23');
    await t.refresh();
    expect((await t.usd()).body.error.code).toBe('RATE_HELD');
  });

  it('accepts the change when BOI repeats it in the next publication', async () => {
    const t = await setup();
    await t.refresh();
    t.boiUsd(3.7, D24);
    t.handlers.sdmx = down;
    await t.refresh();
    await t.refresh();
    expect((await t.usd()).code).toBe(503);
    t.advance(24 * HOUR);
    t.boiUsd(3.71, '2026-11-25T06:00:00Z');
    await t.refresh();
    expect((await t.usd()).body).toMatchObject({ rate: '3.71', status: 'fresh' });
  });

  it('checks the very first rate against ECB', async () => {
    const t = await setup();
    t.boiUsd(33.43);
    t.handlers.sdmx = down;
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
  });

  it('checks the first rate even when ECB is more recent', async () => {
    const t = await setup();
    t.boiUsd(33.43, '2026-11-20T13:00:00Z');
    t.handlers.sdmx = down;
    expect((await t.usd()).body).toMatchObject({ rate: '3.3498', status: 'backup' });
  });

  it('checks a rate received after a restart against the saved one', async () => {
    const t = await setup([stored({})]);
    t.handlers.ecb = down;
    t.handlers.sdmx = down;
    t.boiUsd(33.43);
    expect((await t.usd()).body.error.code).toBe('RATE_HELD');
  });
});
