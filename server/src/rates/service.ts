import type { RateProvider } from '../boi/client.js';
import { InvalidUpstreamDataError } from '../boi/schema.js';
import { REQUIRED_CURRENCIES, toIsraelDate, type Rate, type RateSource, type ServedRate } from '../domain/rates.js';
import type { RateStore, StoredRate } from '../storage/store.js';

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
  store?: RateStore;
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
  storage: 'disabled' | 'unknown' | 'ok' | 'error';
}

export class RatesService {
  private readonly cache = new Map<string, ServedRate>();
  private readonly options: RatesServiceOptions;
  private readonly now: () => number;
  private initialized = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private nextDelayMs = 0;
  private inFlight: Promise<void> | null = null;
  private restored: boolean;
  private readonly unsaved = new Map<string, StoredRate>();
  private saveTimer: NodeJS.Timeout | undefined;
  private pendingSave: Promise<void> = Promise.resolve();
  private storage: ServiceStatus['storage'];
  private lastSuccessAt: string | null = null;
  private lastSource: RateSource | null = null;

  constructor(options: RatesServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.restored = options.store === undefined;
    this.storage = options.store ? 'unknown' : 'disabled';
  }

  /** Keeps the rates fresh in the background, so that requests don't wait for BOI. */
  start(): void {
    const tick = async () => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(tick, this.nextDelayMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
    await this.pendingSave;
    clearTimeout(this.saveTimer);
  }

  /** Rates from memory; waits only for the first refresh. Throws NoRatesError if there are none. */
  async getRates(): Promise<ServedRate[]> {
    if (!this.initialized) await this.refresh();
    if (this.cache.size === 0) throw new NoRatesError('No exchange rates available');
    return this.currentRates();
  }

  /** Never triggers a refresh, so health checks don't call the upstream. */
  status(): ServiceStatus {
    return {
      hasData: this.cache.size > 0,
      stale: this.currentRates().some((r) => r.stale),
      lastSuccessAt: this.lastSuccessAt,
      lastSource: this.lastSource,
      storage: this.storage,
    };
  }

  /** Never rejects. Concurrent callers share a single refresh. */
  refresh(): Promise<void> {
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = null;
      this.initialized = true;
    });
    return this.inFlight;
  }

  /** Also marks rates stale by age, in case the background refresh is delayed or hung. */
  private currentRates(): ServedRate[] {
    const maxAgeMs = this.options.cacheTtlMs + this.options.retryIntervalMs;
    return [...this.cache.values()].map((rate) => ({
      ...rate,
      stale: rate.stale || this.now() - Date.parse(rate.fetchedAt) > maxAgeMs,
    }));
  }

  private async runRefresh(): Promise<void> {
    const { primary, fallback, cacheTtlMs, retryIntervalMs, log } = this.options;
    await this.restore();
    if (await this.tryProvider(primary)) {
      this.nextDelayMs = cacheTtlMs;
      return;
    }
    // The fallback is partial, so return to the primary sooner than the normal TTL.
    if (!(await this.tryProvider(fallback))) {
      this.markAllStale();
      log.error({ cachedRates: this.cache.size }, 'All rate sources failed');
    }
    this.nextDelayMs = retryIntervalMs;
  }

  /** Runs until it succeeds once, so a database that was down at startup still helps later. */
  private async restore(): Promise<void> {
    const { store, log } = this.options;
    if (this.restored || !store) return;
    try {
      const today = this.today();
      for (const rate of await store.load()) {
        if (!this.cache.has(rate.currency) && rate.rateDate <= today) {
          this.cache.set(rate.currency, { ...rate, stale: true });
        }
      }
      this.restored = true;
      this.storage = 'ok';
      log.info({ count: this.cache.size }, 'Rates restored from storage');
    } catch (err) {
      this.storage = 'error';
      log.error({ err }, 'Could not restore rates from storage');
    }
  }

  private async tryProvider(provider: RateProvider): Promise<boolean> {
    const { log } = this.options;
    try {
      const { rates, rejected } = await provider.fetchRates();
      const { valid, future } = this.splitByDate(rates);
      if (rejected.length + future.length > 0) {
        log.warn({ source: provider.name, rejected, future }, 'Dropped invalid rates');
      }
      const fetchedAt = new Date(this.now()).toISOString();
      const accepted = this.merge(valid, fetchedAt);
      this.save(accepted, fetchedAt);
      this.lastSuccessAt = fetchedAt;
      this.lastSource = provider.name;
      log.info({ source: provider.name, count: accepted.length }, 'Rates refreshed');
      return true;
    } catch (err) {
      log.warn({ source: provider.name, err }, 'Rate source failed');
      return false;
    }
  }

  /** A date in the future is wrong, and once cached it would block every correct rate until then. */
  private splitByDate(rates: Rate[]): { valid: Rate[]; future: string[] } {
    const today = this.today();
    const future = rates.filter((r) => r.rateDate > today).map((r) => r.currency);
    if (REQUIRED_CURRENCIES.some((c) => future.includes(c))) {
      throw new InvalidUpstreamDataError(`Rates dated in the future: ${future.join(', ')}`);
    }
    return { valid: rates.filter((r) => r.rateDate <= today), future };
  }

  /**
   * Currencies not renewed by this refresh keep their last known rate, marked stale.
   * Returns the rates that were accepted.
   */
  private merge(rates: Rate[], fetchedAt: string): Rate[] {
    this.markAllStale();
    return rates.filter((rate) => {
      const known = this.cache.get(rate.currency);
      // ISO dates compare correctly as strings.
      if (known && known.rateDate > rate.rateDate) {
        this.options.log.warn(
          { currency: rate.currency, known: known.rateDate, received: rate.rateDate },
          'Ignored a rate older than the cached one',
        );
        return false;
      }
      this.cache.set(rate.currency, { ...rate, fetchedAt, stale: false });
      return true;
    });
  }

  /** In the background: a slow or broken database must not delay or fail a refresh. */
  private save(rates: Rate[], fetchedAt: string): void {
    if (!this.options.store) return;
    for (const rate of rates) {
      // Same key as in the database, so the queue grows only when a new value is published.
      const key = [rate.currency, rate.rateDate, rate.source, rate.rate, rate.unit].join('|');
      this.unsaved.set(key, { ...rate, fetchedAt });
    }
    this.flushUnsaved();
  }

  /** On failure the rates stay queued, so a restart soon after the database recovers loses nothing. */
  private flushUnsaved(): void {
    const { store, log, retryIntervalMs } = this.options;
    if (!store) return;
    clearTimeout(this.saveTimer);
    this.pendingSave = this.pendingSave.then(async () => {
      const batch = [...this.unsaved];
      if (batch.length === 0) return;
      try {
        await store.save(batch.map(([, rate]) => rate));
        for (const [key, rate] of batch) {
          // Unless it was confirmed again while we were saving.
          if (this.unsaved.get(key) === rate) this.unsaved.delete(key);
        }
        this.storage = 'ok';
      } catch (err) {
        this.storage = 'error';
        log.error({ err, unsaved: this.unsaved.size }, 'Could not save rates');
        clearTimeout(this.saveTimer);
        if (!this.stopped) this.saveTimer = setTimeout(() => this.flushUnsaved(), retryIntervalMs);
      }
    });
  }

  private markAllStale(): void {
    for (const [currency, rate] of this.cache) {
      this.cache.set(currency, { ...rate, stale: true });
    }
  }

  private today(): string {
    return toIsraelDate(new Date(this.now()).toISOString());
  }
}
