import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { createBoiProvider, createEcbProvider, createSdmxProvider } from './boi/client.js';
import type { Config } from './config.js';
import { registerErrorHandling } from './http/errors.js';
import { registerRoutes } from './http/routes.js';
import { Alerts, createWebhookSender } from './monitoring/alerts.js';
import { createMetrics, registerMetrics } from './monitoring/metrics.js';
import { RatesService } from './rates/service.js';
import { createPostgresStore } from './storage/postgres.js';
import type { RateStore } from './storage/store.js';

export interface AppOverrides {
  fetchFn?: typeof fetch;
  now?: () => number;
  store?: RateStore;
  logStream?: { write(line: string): void };
}

export async function buildApp(config: Config, overrides: AppOverrides = {}) {
  const app: FastifyInstance = Fastify({
    logger: { level: config.LOG_LEVEL, stream: overrides.logStream },
    // The ID of the caller, if it has a safe format, so that one ID follows a deposit through all systems.
    genReqId: (request) => {
      const id = request.headers['x-request-id'];
      return typeof id === 'string' && /^[\w.-]{1,64}$/.test(id) ? id : randomUUID();
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  const metrics = createMetrics();

  const clientOptions = (source: string, url: string) => ({
    url,
    timeoutMs: config.UPSTREAM_TIMEOUT_MS,
    attempts: config.UPSTREAM_ATTEMPTS,
    backoffMs: config.UPSTREAM_BACKOFF_MS,
    fetchFn: overrides.fetchFn,
    onRetry: (err: unknown, attempt: number) => app.log.warn({ source, attempt, err }, 'Retrying upstream'),
  });

  const store =
    overrides.store ??
    (config.DATABASE_URL
      ? createPostgresStore(config.DATABASE_URL, (err) => app.log.error({ err }, 'Database connection lost'))
      : undefined);

  const service = new RatesService({
    primary: createBoiProvider(clientOptions('boi', config.BOI_URL)),
    fallback: createSdmxProvider(clientOptions('boi-sdmx', config.SDMX_URL)),
    backup: createEcbProvider({
      ...clientOptions('ecb', config.ECB_URL),
      timeoutMs: config.BACKUP_TIMEOUT_MS,
      attempts: Math.min(config.UPSTREAM_ATTEMPTS, 2),
    }),
    store,
    policy: {
      maxAgeMs: config.RATE_MAX_AGE_MS,
      backupMaxAgeDays: config.BACKUP_MAX_AGE_DAYS,
      maxChangePercent: config.MAX_CHANGE_PERCENT,
      confirmTolerancePercent: config.CONFIRM_TOLERANCE_PERCENT,
    },
    backupIntervalMs: config.BACKUP_INTERVAL_MS,
    cacheTtlMs: config.CACHE_TTL_MS,
    retryIntervalMs: config.RETRY_INTERVAL_MS,
    log: app.log,
    onFetch: metrics.countFetch,
    now: overrides.now,
  });

  const alerts = new Alerts({
    getStatus: () => service.status(),
    // Without a webhook, alerts are only logged.
    send: config.ALERT_WEBHOOK_URL ? createWebhookSender(config.ALERT_WEBHOOK_URL) : async () => {},
    warningDelayMs: config.ALERT_WARNING_DELAY_MS,
    checkIntervalMs: config.ALERT_CHECK_INTERVAL_MS,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await alerts.stop();
    await service.stop();
    await store?.close();
  });

  await app.register(swagger, {
    openapi: { info: { title: 'BOI Exchange Rates API', version: '1.0.0' } },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  registerErrorHandling(app);
  registerMetrics(app, metrics, service);
  registerRoutes(app, service, metrics);

  return { app, service, alerts };
}
