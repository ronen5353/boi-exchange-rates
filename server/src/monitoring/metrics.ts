import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { RateSource, ServedRate } from '../domain/rates.js';
import type { RatesService } from '../rates/service.js';

/** A registry per app rather than the global one, so that tests don't share it. */
export function createMetrics() {
  const registry = new Registry();
  const registers = [registry];
  collectDefaultMetrics({ register: registry });

  const fetches = new Counter({
    name: 'boi_source_fetches_total',
    help: 'Attempts to get rates from a source, after its retries',
    labelNames: ['source', 'result'],
    registers,
  });
  const conversions = new Counter({
    name: 'boi_conversions_total',
    help: 'Successful conversions',
    labelNames: ['rate_status'],
    registers,
  });
  const requests = new Histogram({
    name: 'boi_http_request_duration_seconds',
    help: 'Duration of HTTP requests',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5, 30],
    registers,
  });

  return {
    registry,
    countFetch: (source: RateSource, ok: boolean) => fetches.inc({ source, result: ok ? 'success' : 'failure' }),
    countConversion: (status: ServedRate['status']) => conversions.inc({ rate_status: status }),
    observeRequest: (method: string, route: string, status: number, seconds: number) =>
      requests.observe({ method, route, status }, seconds),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

export function registerMetrics(app: FastifyInstance, metrics: Metrics, service: RatesService): void {
  const registers = [metrics.registry];
  // These are read from the service at the time of each scrape.
  new Gauge({
    name: 'boi_ready',
    help: '1 if USD, EUR and GBP can be converted',
    registers,
    collect() {
      this.set(service.status().ready ? 1 : 0);
    },
  });
  new Gauge({
    name: 'boi_rate_age_seconds',
    help: 'Time since the source last confirmed the rate being served',
    labelNames: ['currency', 'source', 'status'],
    registers,
    collect() {
      this.reset();
      for (const { currency, source, status, ageMs } of service.rateAges()) {
        this.set({ currency, source, status }, ageMs / 1000);
      }
    },
  });
  new Gauge({
    name: 'boi_rate_held',
    help: '1 for each currency with an unconfirmed change',
    labelNames: ['currency'],
    registers,
    collect() {
      this.reset();
      for (const currency of service.status().held) this.set({ currency }, 1);
    },
  });
  new Gauge({
    name: 'boi_storage_ok',
    help: '1 if the database works or is not configured',
    registers,
    collect() {
      this.set(service.status().storage === 'error' ? 0 : 1);
    },
  });

  app.addHook('onResponse', async (request, reply) => {
    // The route pattern and not the URL, so that the number of series stays limited.
    const route = request.routeOptions.url ?? 'unknown';
    metrics.observeRequest(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
