import type { RateProvider } from '../boi/client.js';
import type { Rate, RateSource, ServedRate } from '../domain/rates.js';

export class NoRatesError extends Error {
  override name = 'NoRatesError';
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RatesServiceOptions {
  primary: RateProvider;
  fallback: RateProvider;
  cacheTtlMs: number;
  retryIntervalMs: number;
  log: Logger;
  now?: () => number;
}

export interface ServiceStatus {
  hasData: boolean;
  stale: boolean;
  lastSuccessAt: string | null;
  lastSource: RateSource | null;
}

export class RatesService {
  private readonly cache = new Map<string, ServedRate>();
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private lastSuccessAt: string | null = null;
  private lastSource: RateSource | null = null;
  private readonly options: RatesServiceOptions;
  private readonly now: () => number;

  constructor(options: RatesServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Cached rates, refreshed first if due. Throws NoRatesError if there is nothing to serve. */
  async getRates(): Promise<ServedRate[]> {
    if (this.now() >= this.nextRefreshAt) {
      // Concurrent callers share a single refresh.
      this.inFlight ??= this.refresh().finally(() => {
        this.inFlight = null;
      });
      await this.inFlight;
    }
    if (this.cache.size === 0) throw new NoRatesError('No exchange rates available');
    return [...this.cache.values()];
  }

  /** Never triggers a refresh, so health checks don't call the upstream. */
  status(): ServiceStatus {
    return {
      hasData: this.cache.size > 0,
      stale: [...this.cache.values()].some((r) => r.stale),
      lastSuccessAt: this.lastSuccessAt,
      lastSource: this.lastSource,
    };
  }

  private async refresh(): Promise<void> {
    const { primary, fallback, cacheTtlMs, retryIntervalMs, log } = this.options;
    if (await this.tryProvider(primary)) {
      this.nextRefreshAt = this.now() + cacheTtlMs;
      return;
    }
    // The fallback is partial, so return to the primary sooner than the normal TTL.
    if (!(await this.tryProvider(fallback))) {
      this.markAllStale();
      log.error({ cachedRates: this.cache.size }, 'All rate sources failed');
    }
    this.nextRefreshAt = this.now() + retryIntervalMs;
  }

  private async tryProvider(provider: RateProvider): Promise<boolean> {
    const { log } = this.options;
    try {
      const { rates, rejected } = await provider.fetchRates();
      if (rejected.length > 0) {
        log.warn({ source: provider.name, rejected }, 'Dropped invalid rates');
      }
      this.merge(rates);
      this.lastSuccessAt = new Date(this.now()).toISOString();
      this.lastSource = provider.name;
      log.info({ source: provider.name, count: rates.length }, 'Rates refreshed');
      return true;
    } catch (err) {
      log.warn({ source: provider.name, err }, 'Rate source failed');
      return false;
    }
  }

  /** Currencies not renewed by this refresh keep their last known rate, marked stale. */
  private merge(rates: Rate[]): void {
    this.markAllStale();
    const fetchedAt = new Date(this.now()).toISOString();
    for (const rate of rates) {
      const known = this.cache.get(rate.currency);
      // ISO dates compare correctly as strings.
      if (known && known.rateDate > rate.rateDate) {
        this.options.log.warn(
          { currency: rate.currency, known: known.rateDate, received: rate.rateDate },
          'Ignored a rate older than the cached one',
        );
        continue;
      }
      this.cache.set(rate.currency, { ...rate, fetchedAt, stale: false });
    }
  }

  private markAllStale(): void {
    for (const [currency, rate] of this.cache) {
      this.cache.set(currency, { ...rate, stale: true });
    }
  }
}
