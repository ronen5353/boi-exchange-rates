import { setTimeout as sleep } from 'node:timers/promises';
import type { RateSource } from '../domain/rates.js';
import { InvalidUpstreamDataError, parseBoiResponse, parseEcbResponse, parseSdmxResponse, type ParsedRates } from './schema.js';

export class UpstreamHttpError extends Error {
  override name = 'UpstreamHttpError';
  readonly status: number;

  constructor(status: number) {
    super(`Upstream responded with HTTP ${status}`);
    this.status = status;
  }
}

export interface RateProvider {
  readonly name: RateSource;
  fetchRates(): Promise<ParsedRates>;
}

export interface ClientOptions {
  url: string;
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  fetchFn?: typeof fetch;
  onRetry?: (error: unknown, attempt: number) => void;
}

/** Bad data and 4xx won't improve on retry; network errors, timeouts, 429 and 5xx might. */
function isRetryable(error: unknown): boolean {
  if (error instanceof InvalidUpstreamDataError) return false;
  if (error instanceof UpstreamHttpError) return error.status === 429 || error.status >= 500;
  return true;
}

async function fetchText(options: ClientOptions, contentType: string): Promise<string> {
  const response = await (options.fetchFn ?? fetch)(options.url, {
    headers: { accept: contentType },
    // Covers the body as well as the headers.
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamHttpError(response.status);
  }
  const actual = response.headers.get('content-type') ?? '';
  if (!actual.toLowerCase().startsWith(contentType)) {
    // E.g. a bot-protection HTML page served with status 200.
    await response.body?.cancel();
    throw new InvalidUpstreamDataError(`Expected ${contentType}, got "${actual}"`);
  }
  return response.text();
}

function createProvider(
  name: RateSource,
  contentType: string,
  parse: (body: string) => ParsedRates,
  options: ClientOptions,
): RateProvider {
  return {
    name,
    async fetchRates() {
      for (let attempt = 1; ; attempt++) {
        try {
          return parse(await fetchText(options, contentType));
        } catch (error) {
          if (attempt >= options.attempts || !isRetryable(error)) throw error;
          options.onRetry?.(error, attempt);
          // Exponential backoff, with 50-100% jitter so instances don't retry in step.
          const ceiling = options.backoffMs * 2 ** (attempt - 1);
          await sleep(ceiling * (0.5 + Math.random() / 2));
        }
      }
    },
  };
}

export const createBoiProvider = (options: ClientOptions) =>
  createProvider('boi', 'application/json', parseBoiResponse, options);

export const createSdmxProvider = (options: ClientOptions) =>
  createProvider('boi-sdmx', 'text/csv', parseSdmxResponse, options);

export const createEcbProvider = (options: ClientOptions) =>
  createProvider('ecb', 'text/xml', parseEcbResponse, options);
