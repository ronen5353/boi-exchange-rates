import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createBoiProvider, UpstreamHttpError } from '../src/boi/client.js';
import { InvalidUpstreamDataError } from '../src/boi/schema.js';
import { json, status } from './helpers.js';

const setup = (...responses: (() => Promise<Response>)[]) => {
  const fetchFn = vi.fn<typeof fetch>();
  for (const r of responses) fetchFn.mockImplementationOnce(r);
  const provider = createBoiProvider({ url: 'http://boi.test', timeoutMs: 100, attempts: 3, backoffMs: 1, fetchFn });
  return { fetchFn, provider };
};
const networkError = async () => {
  throw new TypeError('fetch failed');
};

describe('BOI client', () => {
  it('retries network errors, 429 and 5xx', async () => {
    const { fetchFn, provider } = setup(networkError, async () => status(429), async () => json());
    expect((await provider.fetchRates()).rates).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the configured attempts', async () => {
    const down = async () => status(503);
    const { fetchFn, provider } = setup(down, down, down, async () => json());
    await expect(provider.fetchRates()).rejects.toThrow(UpstreamHttpError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['404', async () => status(404), UpstreamHttpError],
    [
      'HTML with status 200',
      async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      InvalidUpstreamDataError,
    ],
    ['malformed JSON', async () => json('{'), InvalidUpstreamDataError],
  ])('does not retry %s', async (_name, response, errorType) => {
    const { fetchFn, provider } = setup(response);
    await expect(provider.fetchRates()).rejects.toThrow(errorType);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('times out and retries a body that never finishes (real HTTP)', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"exchangeRates":[');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const provider = createBoiProvider({ url, timeoutMs: 200, attempts: 2, backoffMs: 1 });
      await expect(provider.fetchRates()).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
