import { Decimal } from 'decimal.js';
import type { RateProvider } from '../boi/client.js';
import { InvalidUpstreamDataError } from '../boi/schema.js';
import {
  REQUIRED_CURRENCIES,
  toIsraelDate,
  type Rate,
  type RateSource,
  type ServedRate,
  type StoredRate,
} from '../domain/rates.js';
import type { RateStore } from '../storage/store.js';

export class NoRatesError extends Error {
  override name = 'NoRatesError';
}

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Business rules for using a rate. See the README for the assumptions behind the defaults. */
export interface RatePolicy {
  /** How long a BOI rate may be used after BOI last confirmed it. */
  maxAgeMs: number;
  /** How old the date of a backup rate may be. */
  backupMaxAgeDays: number;
  /** A larger change needs confirmation from another source. */
  maxChangePercent: number;
  /** How close another source must be to confirm a change. */
  confirmTolerancePercent: number;
}

export interface RatesServiceOptions {
  primary: RateProvider;
  fallback: RateProvider;
  /** Not BOI, so it is used only when no BOI rate is usable, and to check BOI rates. */
  backup: RateProvider;
  store?: RateStore;
  policy: RatePolicy;
  cacheTtlMs: number;
  retryIntervalMs: number;
  backupIntervalMs: number;
  log: Logger;
  onFetch?: (source: RateSource, ok: boolean) => void;
  now?: () => number;
}

/** Either a usable rate, or the reason there is none. */
export type RateResult =
  | { rate: ServedRate; unavailable?: undefined }
  | { rate?: undefined; unavailable: 'expired' | 'held' | 'missing' };

export interface ServiceStatus {
  /** Whether the first refresh has ended, successfully or not. */
  initialized: boolean;
  /** Whether every required currency can be converted. */
  ready: boolean;
  hasData: boolean;
  stale: boolean;
  /** Currencies with an unconfirmed change. They may still be served from the backup. */
  held: string[];
  /** Currencies currently served from the backup source. */
  onBackup: string[];
  /** Currencies that can't be served now, and why. */
  unavailable: { currency: string; reason: 'expired' | 'held' | 'missing' }[];
  /** Whether a backup rate exists and is recent enough to use. */
  backupReady: boolean;
  lastSuccessAt: string | null;
  lastSource: RateSource | null;
  storage: 'disabled' | 'unknown' | 'ok' | 'error';
}

const DAY_MS = 86_400_000;
/** A slow backup must not hold back BOI rates on a first start. */
const MAX_BACKUP_WAIT_MS = 3_000;

function differsBy(a: string, b: string, percent: number): boolean {
  return new Decimal(a).div(b).minus(1).abs().mul(100).gt(percent);
}

function find(rates: Rate[], currency: string): Rate | undefined {
  return rates.find((r) => r.currency === currency);
}

export class RatesService {
  /** BOI rates. `renewed` is false when the latest refresh could not renew the rate. */
  private readonly cache = new Map<string, StoredRate & { renewed: boolean }>();
  private readonly backupCache = new Map<string, StoredRate>();
  /** Rates that changed too much and that no other source has confirmed. */
  private readonly held = new Map<string, Rate>();

  private readonly options: RatesServiceOptions;
  private readonly now: () => number;
  private initialized = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private nextDelayMs = 0;
  private inFlight: Promise<void> | null = null;
  private backupInFlight: Promise<void> | null = null;
  private nextBackupAt = 0;
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
    await this.backupInFlight;
    await this.pendingSave;
    clearTimeout(this.saveTimer);
  }

  /** All usable rates, from memory; waits only for the first refresh. */
  async getRates(): Promise<ServedRate[]> {
    if (!this.initialized) await this.refresh();
    const rates = this.usableRates();
    if (rates.length === 0) throw new NoRatesError('No usable exchange rates');
    return rates;
  }

  async getRate(currency: string): Promise<RateResult> {
    if (!this.initialized) await this.refresh();
    return this.resolve(currency);
  }

  /** Never triggers a refresh, so health checks don't call the upstream. */
  status(): ServiceStatus {
    const rates = this.usableRates();
    return {
      initialized: this.initialized,
      ready: this.initialized && REQUIRED_CURRENCIES.every((c) => this.resolve(c).rate !== undefined),
      hasData: rates.length > 0,
      stale: rates.some((r) => r.stale),
      held: [...this.held.keys()],
      onBackup: rates.filter((r) => r.status === 'backup').map((r) => r.currency),
      unavailable: [...new Set<string>([...REQUIRED_CURRENCIES, ...this.cache.keys()])].flatMap((currency) => {
        const { unavailable: reason } = this.resolve(currency);
        return reason ? [{ currency, reason }] : [];
      }),
      backupReady: REQUIRED_CURRENCIES.every((c) => this.usableBackup(c) !== undefined),
      lastSuccessAt: this.lastSuccessAt,
      lastSource: this.lastSource,
      storage: this.storage,
    };
  }

  rateAges() {
    return this.usableRates().map(({ currency, source, status, fetchedAt }) => ({
      currency,
      source,
      status,
      ageMs: this.now() - Date.parse(fetchedAt),
    }));
  }

  /** Never rejects. Concurrent callers share a single refresh. */
  refresh(): Promise<void> {
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = null;
      this.initialized = true;
    });
    return this.inFlight;
  }

  // --- Choosing which rate to serve ---

  private usableRates(): ServedRate[] {
    const currencies = new Set([...this.cache.keys(), ...this.backupCache.keys()]);
    return [...currencies].flatMap((currency) => this.resolve(currency).rate ?? []);
  }

  /** A usable BOI rate, otherwise a usable backup rate, otherwise nothing. */
  private resolve(currency: string): RateResult {
    const { policy, cacheTtlMs, retryIntervalMs } = this.options;
    const known = this.cache.get(currency);
    const held = this.held.get(currency);

    if (known && !held) {
      const ageMs = this.now() - Date.parse(known.fetchedAt);
      if (ageMs <= policy.maxAgeMs) {
        const { renewed, ...rate } = known;
        // By age too, in case the background refresh is delayed or hung.
        const stale = !renewed || ageMs > cacheTtlMs + retryIntervalMs;
        return { rate: { ...rate, stale, status: stale ? 'stale' : 'fresh' } };
      }
    }

    const backup = this.usableBackup(currency);
    // During a hold, an older backup rate says nothing about whether the newer change is real.
    if (backup && (!held || backup.rateDate >= held.rateDate)) {
      return { rate: { ...backup, stale: true, status: 'backup' } };
    }
    return { unavailable: held ? 'held' : known ? 'expired' : 'missing' };
  }

  private usableBackup(currency: string): StoredRate | undefined {
    const backup = this.backupCache.get(currency);
    if (!backup || this.ageInDays(backup.rateDate) > this.options.policy.backupMaxAgeDays) return undefined;
    return backup;
  }

  // --- Refreshing ---

  private async runRefresh(): Promise<void> {
    const { primary, fallback, cacheTtlMs, retryIntervalMs, log } = this.options;
    await this.restore();
    // Not awaited here: normally nothing depends on it.
    void this.refreshBackup();

    if (await this.tryProvider(primary)) {
      this.nextDelayMs = this.held.size > 0 ? retryIntervalMs : cacheTtlMs;
      return;
    }
    // The fallback is partial, so return to the primary sooner than the normal TTL.
    if (!(await this.tryProvider(fallback))) {
      this.markNotRenewed();
      await this.refreshBackup();
      log.error({ cachedRates: this.cache.size, backupRates: this.backupCache.size }, 'All BOI sources failed');
    }
    this.nextDelayMs = retryIntervalMs;
  }

  /** Never rejects. Does nothing if the backup rates were fetched recently. */
  private refreshBackup(): Promise<void> {
    if (this.backupInFlight) return this.backupInFlight;
    if (this.now() < this.nextBackupAt) return Promise.resolve();

    const { backup, backupIntervalMs, retryIntervalMs, log } = this.options;
    const run = async () => {
      try {
        const { valid } = this.splitByDate((await backup.fetchRates()).rates);
        const fetchedAt = this.timestamp();
        const accepted = valid.filter((r) => {
          const known = this.backupCache.get(r.currency);
          return !known || known.rateDate <= r.rateDate;
        });
        for (const rate of accepted) this.backupCache.set(rate.currency, { ...rate, fetchedAt });
        this.save(accepted, fetchedAt);
        this.nextBackupAt = this.now() + backupIntervalMs;
        this.options.onFetch?.(backup.name, true);
      } catch (err) {
        this.nextBackupAt = this.now() + retryIntervalMs;
        this.options.onFetch?.(backup.name, false);
        log.warn({ source: backup.name, err }, 'Backup rate source failed');
      }
    };
    this.backupInFlight = run().finally(() => {
      this.backupInFlight = null;
    });
    return this.backupInFlight;
  }

  private async waitBrieflyForBackup(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, MAX_BACKUP_WAIT_MS);
    });
    await Promise.race([this.refreshBackup(), timeout]);
    clearTimeout(timer);
  }

  private async tryProvider(provider: RateProvider): Promise<boolean> {
    const { log } = this.options;
    try {
      const { rates, rejected } = await provider.fetchRates();
      const { valid, future } = this.splitByDate(rates);
      if (rejected.length + future.length > 0) {
        log.warn({ source: provider.name, rejected, future }, 'Dropped invalid rates');
      }
      const unconfirmed = await this.findUnconfirmed(provider, valid);
      const fetchedAt = this.timestamp();
      const accepted = this.merge(valid, unconfirmed, fetchedAt);
      this.save(accepted, fetchedAt);
      this.lastSuccessAt = fetchedAt;
      this.lastSource = provider.name;
      this.options.onFetch?.(provider.name, true);
      log.info({ source: provider.name, count: accepted.length }, 'Rates refreshed');
      return true;
    } catch (err) {
      this.options.onFetch?.(provider.name, false);
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
   * Currencies whose change is unusual and not confirmed by any other source.
   * Throws if the fallback contradicts the primary, so that the fallback is used instead.
   */
  private async findUnconfirmed(provider: RateProvider, rates: Rate[]): Promise<Set<string>> {
    const { primary, fallback, policy, log } = this.options;
    // With nothing to compare to, the backup is the only check on a first rate.
    if (REQUIRED_CURRENCIES.some((c) => !this.cache.has(c))) await this.waitBrieflyForBackup();

    const suspicious = rates.filter((rate) => {
      const known = this.cache.get(rate.currency);
      // Older than the cached rate, so it will be ignored anyway.
      if (known && known.rateDate > rate.rateDate) return false;
      const backup = this.backupCache.get(rate.currency);
      const changedBy = (other: Rate | undefined) =>
        other !== undefined && differsBy(rate.rate, other.rate, policy.maxChangePercent);
      if (changedBy(known ?? backup)) return true;
      // Also finds a wrong rate that was accepted before the backup was published.
      return backup !== undefined && backup.rateDate >= rate.rateDate && changedBy(backup);
    });
    if (suspicious.length === 0) return new Set();

    await this.refreshBackup();
    const fallbackRates = provider === primary ? await this.fetchForComparison(fallback) : [];
    const unconfirmed = new Set<string>();
    for (const rate of suspicious) {
      const { currency, rateDate } = rate;
      const fromFallback = find(fallbackRates, currency);
      const fromBackup = this.backupCache.get(currency);
      const agrees = (other: Rate | undefined) =>
        other !== undefined && !differsBy(rate.rate, other.rate, policy.confirmTolerancePercent);

      // The same change in two publications is not a one-time error.
      const earlier = this.held.get(currency);
      const repeated =
        earlier !== undefined &&
        rateDate > earlier.rateDate &&
        !differsBy(rate.rate, earlier.rate, policy.maxChangePercent);

      // A source contradicts only if it is at least as recent.
      const contradicts = (other: Rate | undefined) =>
        other !== undefined && other.rateDate >= rateDate && !agrees(other);

      if (contradicts(fromFallback) && !agrees(fromBackup)) {
        throw new InvalidUpstreamDataError(
          `${currency} changed unusually to ${rate.rate}, but ${fallback.name} says ${fromFallback?.rate}`,
        );
      }
      // The fallback is BOI too, so it can repeat BOI's own mistake: the backup outweighs it.
      if (!contradicts(fromBackup) && (agrees(fromBackup) || agrees(fromFallback) || repeated)) {
        log.warn({ currency, rate: rate.rate, source: provider.name }, 'Unusual rate change confirmed');
      } else {
        unconfirmed.add(currency);
      }
    }
    return unconfirmed;
  }

  private async fetchForComparison(provider: RateProvider): Promise<Rate[]> {
    try {
      return this.splitByDate((await provider.fetchRates()).rates).valid;
    } catch (err) {
      this.options.log.warn({ source: provider.name, err }, 'Could not compare with another source');
      return [];
    }
  }

  /**
   * Currencies not renewed by this refresh keep their last known rate.
   * Returns the rates that were accepted.
   */
  private merge(rates: Rate[], unconfirmed: Set<string>, fetchedAt: string): Rate[] {
    const { log } = this.options;
    this.markNotRenewed();
    return rates.filter((rate) => {
      const { currency } = rate;
      const known = this.cache.get(currency);
      // ISO dates compare correctly as strings.
      if (known && known.rateDate > rate.rateDate) {
        log.warn(
          { currency, known: known.rateDate, received: rate.rateDate },
          'Ignored a rate older than the cached one',
        );
        return false;
      }
      if (unconfirmed.has(currency)) {
        const earlier = this.held.get(currency);
        if (!earlier || earlier.rateDate < rate.rateDate) this.held.set(currency, rate);
        log.error({ currency, known: known?.rate, received: rate.rate }, 'Unusual rate change held');
        return false;
      }
      const held = this.held.get(currency);
      // An older normal rate from another source doesn't settle a newer change.
      if (held && rate.rateDate < held.rateDate) return false;
      this.held.delete(currency);
      this.cache.set(currency, { ...rate, fetchedAt, renewed: true });
      return true;
    });
  }

  private markNotRenewed(): void {
    for (const rate of this.cache.values()) rate.renewed = false;
  }

  // --- Storage ---

  /** Runs until it succeeds once, so a database that was down at startup still helps later. */
  private async restore(): Promise<void> {
    const { store, log } = this.options;
    if (this.restored || !store) return;
    try {
      const today = this.today();
      for (const rate of await store.load()) {
        if (rate.rateDate > today) continue;
        if (rate.source === 'ecb') {
          if (!this.backupCache.has(rate.currency)) this.backupCache.set(rate.currency, rate);
        } else if (!this.cache.has(rate.currency)) {
          this.cache.set(rate.currency, { ...rate, renewed: false });
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

  // --- Time ---

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private today(): string {
    return toIsraelDate(this.timestamp());
  }

  private ageInDays(isoDate: string): number {
    return (Date.parse(this.today()) - Date.parse(isoDate)) / DAY_MS;
  }
}
