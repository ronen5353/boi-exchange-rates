import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Alerts, createWebhookSender, findProblems } from '../src/monitoring/alerts.js';
import type { ServiceStatus } from '../src/rates/service.js';
import { fakeUpstream, status as httpStatus, xml } from './helpers.js';

const healthy: ServiceStatus = {
  initialized: true,
  ready: true,
  hasData: true,
  stale: false,
  held: [],
  onBackup: [],
  unavailable: [],
  backupReady: true,
  lastSuccessAt: '2026-11-24T08:00:00.000Z',
  lastSource: 'boi',
  storage: 'ok',
};
const usdHeld: ServiceStatus = { ...healthy, ready: false, held: ['USD'], unavailable: [{ currency: 'USD', reason: 'held' }] };

describe('findProblems', () => {
  const keys = (s: Partial<ServiceStatus>) => findProblems({ ...healthy, ...s }).map((p) => `${p.severity} ${p.key}`);

  it.each<[Partial<ServiceStatus>, string[]]>([
    [{}, []],
    [{ initialized: false, backupReady: false }, []],
    [{ unavailable: [{ currency: 'USD', reason: 'expired' }] }, ['critical unavailable:USD']],
    [{ unavailable: [{ currency: 'LBP', reason: 'expired' }] }, ['warning unavailable:LBP']],
    [{ held: ['USD'] }, ['critical held:USD']],
    [{ onBackup: ['USD'], stale: true }, ['critical backup', 'warning stale']],
    [{ backupReady: false }, ['warning no-backup']],
    [{ storage: 'error' }, ['warning storage']],
  ])('%j', (change, expected) => {
    expect(keys(change)).toEqual(expected);
  });
});

describe('Alerts', () => {
  function setup() {
    let status = healthy;
    let time = 0;
    const send = vi.fn(async (_text: string) => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const alerts = new Alerts({
      getStatus: () => status,
      send,
      warningDelayMs: 60_000,
      checkIntervalMs: 1,
      log,
      now: () => time,
    });
    const check = (next: ServiceStatus, afterMs = 0) => {
      status = next;
      time += afterMs;
      return alerts.check();
    };
    return { alerts, send, log, check, labels: () => send.mock.calls.map(([t]) => t.match(/^\[(\w+)\]/)![1]) };
  }

  it('announces a critical problem immediately, once, and its end', async () => {
    const { check, labels } = setup();
    await check(healthy);
    expect(labels()).toEqual([]);
    await check(usdHeld);
    expect(labels()).toEqual(['CRITICAL', 'CRITICAL']);
    await check(usdHeld, 3_600_000);
    expect(labels()).toHaveLength(2);
    await check(healthy);
    expect(labels().slice(2)).toEqual(['RESOLVED', 'RESOLVED']);
    await check(healthy);
    expect(labels()).toHaveLength(4);
  });

  it('announces a warning only if it lasts', async () => {
    const { check, labels } = setup();
    const broken: ServiceStatus = { ...healthy, storage: 'error' };
    await check(broken);
    await check(healthy, 30_000);
    expect(labels()).toEqual([]);
    await check(broken);
    await check(broken, 60_000);
    expect(labels()).toEqual(['WARNING']);
  });

  it('retries when an alert or its end could not be sent', async () => {
    const { check, send, log, labels } = setup();
    const backup: ServiceStatus = { ...healthy, onBackup: ['USD'] };
    send.mockRejectedValueOnce(new Error('down'));
    await check(backup);
    expect(log.error).toHaveBeenCalledOnce();
    await check(backup);
    await check(backup);
    expect(labels()).toEqual(['CRITICAL', 'CRITICAL']);
    send.mockRejectedValueOnce(new Error('down'));
    await check(healthy);
    await check(healthy);
    await check(healthy);
    expect(labels().slice(2)).toEqual(['RESOLVED', 'RESOLVED']);
  });

  it('does not run twice at the same time', async () => {
    const { alerts, check, send } = setup();
    await Promise.all([check(usdHeld), alerts.check(), alerts.check()]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('webhook', () => {
  it('posts the text, and rejects on an error status', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => httpStatus(200));
    const send = createWebhookSender('http://hook.test', fetchFn);
    await send('hello');
    expect(fetchFn.mock.calls[0]![1]!.body).toBe('{"text":"hello"}');
    fetchFn.mockResolvedValue(httpStatus(500));
    await expect(send('hello')).rejects.toThrow('HTTP 500');
  });
});

describe('endpoints', () => {
  const down = async () => httpStatus(503);
  let closeApp: () => Promise<unknown> = async () => {};
  afterEach(() => closeApp());

  async function setup() {
    const upstream = fakeUpstream();
    const { app, service } = await buildApp(loadConfig({ LOG_LEVEL: 'silent', UPSTREAM_ATTEMPTS: '1' }), {
      fetchFn: upstream.fetchFn,
      now: () => Date.parse('2026-11-24T08:00:00Z'),
    });
    closeApp = () => app.close();
    return { app, service, ...upstream };
  }

  it('/ready is 503 until rates are loaded', async () => {
    const { app, service, calls } = await setup();
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect(calls.boi).toBe(0);
    await service.refresh();
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });

  it('/ready is 503 without rates, while /health is 200', async () => {
    const { app, service, handlers } = await setup();
    handlers.boi = down;
    handlers.sdmx = down;
    await service.refresh();
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('/ready is 200 on backup rates', async () => {
    const { app, service, handlers } = await setup();
    handlers.boi = down;
    handlers.sdmx = down;
    handlers.ecb = async () => xml();
    await service.refresh();
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });

  it('/metrics exposes rates, sources, requests and conversions', async () => {
    const { app, handlers, service } = await setup();
    await app.inject('/api/convert?from=ILS&to=USD&amount=1000');
    await app.inject('/api/rates/XYZ');
    await app.inject('/random-1');
    await app.inject('/random-2');
    handlers.boi = down;
    await service.refresh();
    const { body, headers } = await app.inject('/metrics');
    expect(headers['content-type']).toContain('text/plain');
    expect(body).toContain('boi_ready 1');
    expect(body).toContain('boi_rate_age_seconds{currency="USD",source="boi-sdmx",status="fresh"} 0');
    expect(body).toContain('boi_source_fetches_total{source="boi",result="success"} 1');
    expect(body).toContain('boi_source_fetches_total{source="boi",result="failure"} 1');
    expect(body).toContain('boi_source_fetches_total{source="ecb",result="failure"}');
    expect(body).toContain('boi_conversions_total{rate_status="fresh"} 1');
    expect(body).toContain('boi_http_request_duration_seconds_count{method="GET",route="/api/rates/:currency",status="404"} 1');
    expect(body).toContain('boi_http_request_duration_seconds_count{method="GET",route="unknown",status="404"} 2');
    expect(body).not.toContain('random');
  });

  it('keeps the request ID of the caller, unless it is unsafe', async () => {
    const { app } = await setup();
    const id = async (value?: string) =>
      (await app.inject({ url: '/health', headers: value ? { 'x-request-id': value } : {} })).headers['x-request-id'];
    expect(await id('deposit-123')).toBe('deposit-123');
    expect(await id('bad id {"x":1}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await id('a'.repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
    expect(await id()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
