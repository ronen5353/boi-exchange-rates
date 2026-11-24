import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { boiBody, boiItem, boiItems, csv, fakeUpstream, json, sdmxBody, status } from './helpers.js';

const TTL = 300_000;
const RETRY = 30_000;
const down = async () => status(503);

let upstream: ReturnType<typeof fakeUpstream>;
let time: number;
let refresh: () => Promise<void>;
let get: (url: string) => Promise<{ code: number; body: any }>;

beforeEach(async () => {
  upstream = fakeUpstream();
  time = Date.parse('2026-11-24T08:00:00Z');
  const config = loadConfig({ LOG_LEVEL: 'silent', UPSTREAM_ATTEMPTS: '1' });
  const { app, service } = await buildApp(config, { fetchFn: upstream.fetchFn, now: () => time });
  refresh = () => service.refresh();
  get = async (url) => {
    const res = await app.inject(url);
    return { code: res.statusCode, body: res.json() };
  };
  return async () => {
    await app.close();
  };
});

describe('endpoints', () => {
  it('GET /api/rates returns every rate', async () => {
    const { code, body } = await get('/api/rates');
    expect(code).toBe(200);
    expect(body).toMatchObject({ base: 'ILS', stale: false });
    expect(body.rates).toHaveLength(5);
  });

  it('GET /api/rates/:currency is case-insensitive', async () => {
    const { code, body } = await get('/api/rates/jpy');
    expect(code).toBe(200);
    expect(body).toEqual({
      base: 'ILS',
      currency: 'JPY',
      rate: '0.021026',
      officialRate: '2.1026',
      unit: 100,
      changePercent: '0.5111',
      rateDate: '2026-11-23',
      lastUpdate: '2026-11-23T13:21:10.7104898Z',
      source: 'boi',
      fetchedAt: '2026-11-24T08:00:00.000Z',
      stale: false,
    });
  });

  it('returns 404 for an unsupported currency', async () => {
    expect(await get('/api/rates/XYZ')).toMatchObject({ code: 404, body: { error: { code: 'UNSUPPORTED_CURRENCY' } } });
  });

  it('returns 404 in the same format for an unknown route', async () => {
    expect(await get('/nope')).toMatchObject({ code: 404, body: { error: { code: 'NOT_FOUND' } } });
  });

  it('documents the endpoints', async () => {
    const { body } = await get('/docs/json');
    expect(Object.keys(body.paths)).toEqual(expect.arrayContaining(['/api/rates', '/api/rates/{currency}', '/health']));
  });

  it('GET /health reports data status without calling BOI', async () => {
    expect(await get('/health')).toMatchObject({ code: 200, body: { status: 'ok', rates: { hasData: false } } });
    expect(upstream.calls).toEqual({ boi: 0, sdmx: 0 });
    await get('/api/rates');
    expect((await get('/health')).body.rates).toMatchObject({ hasData: true, stale: false, lastSource: 'boi' });
  });
});

describe('caching', () => {
  it('calls BOI only for the first request', async () => {
    await get('/api/rates');
    time += TTL;
    await get('/api/rates');
    expect(upstream.calls.boi).toBe(1);
  });

  it('shares one upstream call between concurrent requests', async () => {
    await Promise.all(Array.from({ length: 20 }, () => get('/api/rates')));
    expect(upstream.calls.boi).toBe(1);
  });

  it('does not call an old weekend rate stale when BOI confirmed it', async () => {
    time = Date.parse('2026-11-29T08:00:00Z');
    const { body } = await get('/api/rates/USD');
    expect(body).toMatchObject({ rateDate: '2026-11-23', stale: false });
  });
});

describe('outages', () => {
  it('uses SDMX on a cold start when BOI is down', async () => {
    upstream.handlers.boi = down;
    const { body } = await get('/api/rates');
    expect(body.stale).toBe(false);
    expect(body.rates).toHaveLength(3);
    expect(body.rates[0]).toMatchObject({ source: 'boi-sdmx', changePercent: null });
    // Supported, but SDMX doesn't provide it.
    expect(await get('/api/rates/JPY')).toMatchObject({ code: 503, body: { error: { code: 'RATE_UNAVAILABLE' } } });
  });

  it('merges SDMX rates with last known rates of other currencies', async () => {
    await get('/api/rates');
    upstream.handlers.boi = down;
    time += TTL;
    await refresh();
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.35', source: 'boi-sdmx', stale: false });
    expect((await get('/api/rates/JPY')).body).toMatchObject({ source: 'boi', stale: true });
    expect((await get('/api/rates')).body.stale).toBe(true);
  });

  it('serves stale data when both sources fail, then recovers', async () => {
    await get('/api/rates');
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = down;
    time += TTL;
    await refresh();
    expect((await get('/api/rates/USD')).body).toMatchObject({
      rate: '3.343',
      stale: true,
      fetchedAt: '2026-11-24T08:00:00.000Z',
    });
    expect((await get('/health')).body.rates.stale).toBe(true);

    upstream.handlers.boi = async () => json();
    time += RETRY;
    await refresh();
    expect((await get('/api/rates')).body.stale).toBe(false);
  });

  it('returns 503 with no data at all, and does not hammer BOI', async () => {
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = down;
    expect(await get('/api/rates')).toMatchObject({ code: 503, body: { error: { code: 'NO_DATA' } } });
    expect((await get('/api/rates/USD')).code).toBe(503);
    expect((await get('/api/rates/XYZ')).code).toBe(404);
    expect(upstream.calls).toEqual({ boi: 1, sdmx: 1 });
  });

  it('never replaces good data with malformed data', async () => {
    await get('/api/rates');
    upstream.handlers.boi = async () => json(boiBody([boiItem('USD', -1)]));
    upstream.handlers.sdmx = async () => csv('garbage');
    time += TTL;
    await refresh();
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.343', stale: true });
  });

  it('keeps the last known rate of a currency missing from a new response', async () => {
    await get('/api/rates');
    upstream.handlers.boi = async () => json(boiBody(boiItems().filter((i) => i.key !== 'JPY')));
    time += TTL;
    await refresh();
    expect((await get('/api/rates/JPY')).body).toMatchObject({ rate: '0.021026', stale: true });
    expect((await get('/api/rates/USD')).body.stale).toBe(false);
  });

  it('does not go back to an older rate', async () => {
    await get('/api/rates');
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = async () => csv(sdmxBody('2026-11-20'));
    time += TTL;
    await refresh();
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.343', rateDate: '2026-11-23', stale: true });
  });
});

it('rejects invalid configuration', () => {
  expect(() => loadConfig({ CACHE_TTL_MS: '-5' })).toThrow();
});
