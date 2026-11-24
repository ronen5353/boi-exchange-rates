import type { ServedRate } from '../domain/rates.js';

export type StoredRate = Omit<ServedRate, 'stale'>;

/** Keeps rates across restarts. It may fail: callers must be able to continue without it. */
export interface RateStore {
  /** The last known rate of each currency. */
  load(): Promise<StoredRate[]>;
  save(rates: StoredRate[]): Promise<void>;
  close(): Promise<void>;
}
