import type { StoredRate } from '../domain/rates.js';

/** Keeps rates across restarts. It may fail: callers must be able to continue without it. */
export interface RateStore {
  /** The last known rate of each currency, separately for BOI and ECB. */
  load(): Promise<StoredRate[]>;
  save(rates: StoredRate[]): Promise<void>;
  close(): Promise<void>;
}
