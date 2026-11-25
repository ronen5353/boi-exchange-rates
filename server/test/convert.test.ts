import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { convertAmount } from '../src/domain/convert.js';
import { boiBody, boiItem, boiItems, ecbBody, fakeUpstream, json, status, xml } from './helpers.js';

describe('convertAmount', () => {
  it.each([
    ['1000', 'USD', '3.343', '299.13'],
    ['1000', 'ILS', '3.343', '3343.00'],
    ['1.01', 'ILS', '0.5', '0.51'],
    ['1000', 'JPY', '0.021026', '47560'],
    ['1000', 'JOD', '4.7157', '212.058'],
    ['999999999999.99', 'ILS', '4.3785', '4378499999999.96'],
    ['1000', 'LBP', '0.00004', '25000000.00'],
  ])('%s to %s at %s is %s', (amount, to, rate, expected) => {
    expect(convertAmount(amount, to, rate)).toBe(expected);
  });
});

describe('GET /api/convert', () => {
  const down = async () => status(503);
  let upstream: ReturnType<typeof fakeUpstream>;
  let logs: string[];
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let service: Awaited<ReturnType<typeof buildApp>>['service'];

  beforeEach(async () => {
    upstream = fakeUpstream();
    logs = [];
    const built = await buildApp(loadConfig({ LOG_LEVEL: 'info', UPSTREAM_ATTEMPTS: '1' }), {
      fetchFn: upstream.fetchFn,
      now: () => Date.parse('2026-11-24T08:00:00Z'),
      logStream: { write: (line) => void logs.push(line) },
    });
    ({ app, service } = built);
  });
  afterEach(() => app.close());

  const convert = async (query: string) => {
    const res = await app.inject(`/api/convert?${query}`);
    return { code: res.statusCode, body: res.json(), headers: res.headers };
  };

  it('converts a deposit in ILS to USD', async () => {
    const { code, body, headers } = await convert('from=ILS&to=USD&amount=1000');
    expect(code).toBe(200);
    expect(body).toMatchObject({
      from: 'ILS',
      to: 'USD',
      amount: '1000',
      result: '299.13',
      rate: { currency: 'USD', rate: '3.343', source: 'boi', status: 'fresh', rateDate: '2026-11-23' },
    });
    expect(body.conversionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['cache-control']).toBe('no-store');
  });

  it('converts back, and is case-insensitive', async () => {
    expect((await convert('from=usd&to=ils&amount=10.50')).body.result).toBe('35.10');
  });

  it('logs every conversion with its ID, and gives each a new ID', async () => {
    const first = (await convert('from=ILS&to=USD&amount=1000')).body;
    const second = (await convert('from=ILS&to=USD&amount=1000')).body;
    expect(first.conversionId).not.toBe(second.conversionId);
    const entry = logs.map((l) => JSON.parse(l)).find((l) => l.conversionId === first.conversionId);
    expect(entry).toMatchObject({ from: 'ILS', to: 'USD', amount: '1000', result: '299.13', rate: { rate: '3.343' } });
  });

  it.each([
    ['', 'BAD_REQUEST'],
    ['from=ILS&to=USD', 'BAD_REQUEST'],
    ['from=ILS&to=USD&amount=1&amount=2', 'BAD_REQUEST'],
    ['from=ILS&to=USD&amount=1&officialOnly=maybe', 'BAD_REQUEST'],
    ['from=USD&to=EUR&amount=1', 'UNSUPPORTED_PAIR'],
    ['from=ILS&to=ILS&amount=1', 'UNSUPPORTED_PAIR'],
    ['from=ILS&to=USD&amount=0', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=-5', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=abc', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=1e5', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=1,000', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=1.005', 'INVALID_AMOUNT'],
    ['from=JPY&to=ILS&amount=1.5', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=1234567890123', 'INVALID_AMOUNT'],
    ['from=ILS&to=USD&amount=0.01', 'AMOUNT_TOO_SMALL'],
  ])('rejects %j with %s', async (query, errorCode) => {
    expect(await convert(query)).toMatchObject({ code: 400, body: { error: { code: errorCode } } });
  });

  it('returns 404 for an unsupported currency', async () => {
    expect(await convert('from=ILS&to=XYZ&amount=1')).toMatchObject({
      code: 404,
      body: { error: { code: 'UNSUPPORTED_CURRENCY' } },
    });
  });

  it('returns 503 without a usable rate, and converts nothing', async () => {
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = down;
    const { code, body } = await convert('from=ILS&to=USD&amount=1000');
    expect(code).toBe(503);
    expect(body.result).toBeUndefined();
  });

  it('does not convert with a held rate', async () => {
    await convert('from=ILS&to=USD&amount=1000');
    upstream.handlers.sdmx = down;
    upstream.handlers.boi = async () => json(boiBody([boiItem('USD', 33.43), ...boiItems().slice(1)]));
    await service.refresh();
    expect(await convert('from=ILS&to=USD&amount=1000')).toMatchObject({
      code: 503,
      body: { error: { code: 'RATE_HELD' } },
    });
  });

  it('marks a conversion with the backup rate, unless the caller accepts only BOI', async () => {
    upstream.handlers.boi = down;
    upstream.handlers.sdmx = down;
    upstream.handlers.ecb = async () => xml(ecbBody());
    expect((await convert('from=ILS&to=USD&amount=1000')).body).toMatchObject({
      result: '298.53',
      rate: { source: 'ecb', status: 'backup' },
    });
    expect(await convert('from=ILS&to=USD&amount=1000&officialOnly=true')).toMatchObject({
      code: 503,
      body: { error: { code: 'RATE_NOT_OFFICIAL' } },
    });
  });
});
