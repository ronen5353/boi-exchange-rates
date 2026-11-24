import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { RateStore, StoredRate } from '../src/storage/store.js';
import { boiBody, boiItem, boiItems, csv, fakeUpstream, json, sdmxBody, status } from './helpers.js';

const down = async () => status(503);
const storedUsd: StoredRate = {
  currency: 'USD',
  rate: '3.3',
  officialRate: '3.3',
  unit: 1,
  changePercent: null,
  rateDate: '2026-11-20',
  lastUpdate: null,
  source: 'boi',
  fetchedAt: '2026-11-20T14:00:00.000Z',
};

function fakeStore() {
  return {
    load: vi.fn<RateStore['load']>(async () => []),
    save: vi.fn<RateStore['save']>(async () => {}),
    close: vi.fn<RateStore['close']>(async () => {}),
  };
}

let closeApp: () => Promise<unknown> = async () => {};
afterEach(async () => {
  await closeApp();
  vi.useRealTimers();
});

async function setup() {
  const upstream = fakeUpstream();
  const store = fakeStore();
  let time = Date.parse('2026-11-24T08:00:00Z');
  const { app, service } = await buildApp(loadConfig({ LOG_LEVEL: 'silent', UPSTREAM_ATTEMPTS: '1' }), {
    fetchFn: upstream.fetchFn,
    now: () => time,
    store,
  });
  closeApp = () => app.close();
  const get = async (url: string) => {
    const res = await app.inject(url);
    return { code: res.statusCode, body: res.json() };
  };
  return { upstream, store, service, get, advance: (ms: number) => (time += ms) };
}

describe('storage', () => {
  it('survives a restart during a full outage', async () => {
    const { upstream, store, get } = await setup();
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = down;
    store.load.mockResolvedValue([storedUsd]);
    expect(await get('/api/rates/USD')).toMatchObject({
      code: 200,
      body: { rate: '3.3', stale: true, rateDate: '2026-11-20', fetchedAt: '2026-11-20T14:00:00.000Z' },
    });
  });

  it('prefers fresh rates to stored ones, and saves them', async () => {
    const { store, get } = await setup();
    store.load.mockResolvedValue([storedUsd]);
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.343', stale: false });
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.save.mock.calls[0]![0]).toHaveLength(5);
  });

  it('does not go back to a rate older than the stored one', async () => {
    const { store, get } = await setup();
    store.load.mockResolvedValue([{ ...storedUsd, rate: '3.4', rateDate: '2026-11-24' }]);
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.4', stale: true });
    expect(store.save.mock.calls[0]![0].map((r) => r.currency)).not.toContain('USD');
  });

  it('keeps working when the database is down, and reports it', async () => {
    const { store, get } = await setup();
    store.load.mockRejectedValue(new Error('down'));
    store.save.mockRejectedValue(new Error('down'));
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.343', stale: false });
    expect((await get('/health')).body).toMatchObject({ status: 'ok', rates: { storage: 'error' } });
  });

  it('is not delayed by a hung save', async () => {
    const { store, get } = await setup();
    let finish = () => {};
    store.save.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    expect((await get('/api/rates/USD')).code).toBe(200);
    finish();
  });

  it('restores later if the database was down at startup', async () => {
    const { upstream, store, service, get } = await setup();
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = down;
    store.load.mockRejectedValueOnce(new Error('down')).mockResolvedValue([storedUsd]);
    expect((await get('/api/rates/USD')).code).toBe(503);
    await service.refresh();
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.3', stale: true });
  });

  it('ignores a stored rate dated in the future', async () => {
    const { store, get } = await setup();
    store.load.mockResolvedValue([{ ...storedUsd, rateDate: '2030-01-01' }]);
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.343', stale: false });
  });
});

describe('failed saves', () => {
  it('are retried without another call to BOI', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { upstream, store, get } = await setup();
    store.save.mockRejectedValueOnce(new Error('down'));
    await get('/api/rates');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save.mock.calls[1]![0]).toEqual(store.save.mock.calls[0]![0]);
    expect((await get('/health')).body.rates.storage).toBe('ok');
    expect(upstream.calls.boi).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it('keep every published value for the history', async () => {
    const { upstream, store, service } = await setup();
    store.save.mockRejectedValueOnce(new Error('down'));
    await service.refresh();
    upstream.handlers.boi = async () => json(boiBody([boiItem('USD', 3.4), ...boiItems().slice(1)]));
    await service.refresh();
    await service.stop();
    const saved = store.save.mock.calls[1]![0].filter((r) => r.currency === 'USD').map((r) => r.rate);
    expect(saved).toEqual(['3.343', '3.4']);
  });
});

describe('dates in the future', () => {
  it('rejects the response when a required currency is affected', async () => {
    const { upstream, get } = await setup();
    upstream.handlers.boi = async () =>
      json(boiBody([boiItem('USD', 3.3, 1, '2026-11-26T13:00:00Z'), ...boiItems().slice(1)]));
    expect((await get('/api/rates/USD')).body.source).toBe('boi-sdmx');
  });

  it('drops only an optional currency', async () => {
    const { upstream, get } = await setup();
    upstream.handlers.boi = async () =>
      json(boiBody([...boiItems().slice(0, 4), boiItem('LBP', 1, 10, '2026-11-26T13:00:00Z')]));
    expect((await get('/api/rates/USD')).body.source).toBe('boi');
    expect((await get('/api/rates/LBP')).code).toBe(503);
  });

  it('applies to SDMX too', async () => {
    const { upstream, get } = await setup();
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = async () => csv(sdmxBody('2026-11-26'));
    expect((await get('/api/rates/USD')).code).toBe(503);
  });
});

describe('background refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('refreshes every TTL, or sooner after a failure, without any request', async () => {
    const { upstream, service } = await setup();
    service.start();
    await service.refresh();
    expect(upstream.calls.boi).toBe(1);
    upstream.handlers.boi = down;
    await vi.advanceTimersByTimeAsync(300_000);
    await service.refresh();
    const afterFailure = upstream.calls.boi;
    expect(afterFailure).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await service.refresh();
    expect(upstream.calls.boi).toBeGreaterThan(afterFailure);
  });

  it('stops', async () => {
    const { upstream, service } = await setup();
    service.start();
    await service.stop();
    const calls = upstream.calls.boi;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(upstream.calls.boi).toBe(calls);
  });

  it('answers from memory while a refresh is hung', async () => {
    const { upstream, service, get } = await setup();
    await get('/api/rates');
    let finish = (_: Response) => {};
    upstream.handlers.boi = () => new Promise((resolve) => (finish = resolve));
    const refreshing = service.refresh();
    expect((await get('/api/rates/USD')).body).toMatchObject({ rate: '3.343', stale: false });
    finish(json());
    await refreshing;
  });

  it('marks rates stale by age if refreshing stops', async () => {
    const { get, advance } = await setup();
    await get('/api/rates');
    advance(330_000);
    expect((await get('/api/rates/USD')).body.stale).toBe(false);
    advance(1);
    expect((await get('/api/rates/USD')).body.stale).toBe(true);
  });
});
