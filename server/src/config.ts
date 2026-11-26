import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

const ConfigSchema = z.object({
  PORT: positiveInt.max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Keeps answering for this long after a shutdown signal, so that a load balancer can stop using us. */
  SHUTDOWN_DELAY_MS: z.coerce.number().int().min(0).max(5_000).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BOI_URL: z.url().default('https://boi.org.il/PublicApi/GetExchangeRates'),
  SDMX_URL: z
    .url()
    .default(
      'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/' +
        'RER_USD_ILS,RER_EUR_ILS,RER_GBP_ILS?lastNObservations=1&format=csv',
    ),
  // The static daily file: ECB's data API was seen taking up to 17 seconds.
  ECB_URL: z.url().default('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'),
  /** Optional. Without it, rates are kept in memory only. */
  DATABASE_URL: z.url().optional(),
  /** How long a successful primary response is considered fresh. */
  CACHE_TTL_MS: positiveInt.default(300_000),
  /** Wait before trying again after a failure, or after having to use the fallback. */
  RETRY_INTERVAL_MS: positiveInt.default(30_000),
  BACKUP_INTERVAL_MS: positiveInt.default(3_600_000),
  // Business rules; see RatePolicy.
  RATE_MAX_AGE_MS: positiveInt.default(86_400_000),
  BACKUP_MAX_AGE_DAYS: positiveInt.default(4),
  MAX_CHANGE_PERCENT: z.coerce.number().positive().default(5),
  CONFIRM_TOLERANCE_PERCENT: z.coerce.number().positive().default(2),
  /** Optional. A Slack-compatible incoming webhook; it is a secret. */
  ALERT_WEBHOOK_URL: z.url().optional(),
  ALERT_WARNING_DELAY_MS: positiveInt.default(60_000),
  ALERT_CHECK_INTERVAL_MS: positiveInt.default(10_000),
  UPSTREAM_TIMEOUT_MS: positiveInt.default(3_000),
  BACKUP_TIMEOUT_MS: positiveInt.default(10_000),
  UPSTREAM_ATTEMPTS: positiveInt.max(10).default(3),
  UPSTREAM_BACKOFF_MS: positiveInt.default(200),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Throws on invalid configuration, so a misconfigured process never starts. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return ConfigSchema.parse(env);
}
