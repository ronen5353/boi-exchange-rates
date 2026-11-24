import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { createBoiProvider, createSdmxProvider } from './boi/client.js';
import type { Config } from './config.js';
import { registerErrorHandling } from './http/errors.js';
import { registerRoutes } from './http/routes.js';
import { RatesService } from './rates/service.js';
import { createPostgresStore } from './storage/postgres.js';
import type { RateStore } from './storage/store.js';

export interface AppOverrides {
  fetchFn?: typeof fetch;
  now?: () => number;
  store?: RateStore;
}

export async function buildApp(config: Config, overrides: AppOverrides = {}) {
  const app: FastifyInstance = Fastify({ logger: { level: config.LOG_LEVEL } });

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
    store,
    cacheTtlMs: config.CACHE_TTL_MS,
    retryIntervalMs: config.RETRY_INTERVAL_MS,
    log: app.log,
    now: overrides.now,
  });

  app.addHook('onClose', async () => {
    await service.stop();
    await store?.close();
  });

  await app.register(swagger, {
    openapi: { info: { title: 'BOI Exchange Rates API', version: '1.0.0' } },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  registerErrorHandling(app);
  registerRoutes(app, service);

  return { app, service };
}
