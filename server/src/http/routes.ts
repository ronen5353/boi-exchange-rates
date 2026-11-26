import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { convertAmount, decimalsOf, isValidAmount } from '../domain/convert.js';
import { REQUIRED_CURRENCIES, SUPPORTED_CURRENCIES, type ServedRate } from '../domain/rates.js';
import type { Metrics } from '../monitoring/metrics.js';
import type { RatesService } from '../rates/service.js';
import { ApiError } from './errors.js';
import { conversionResponse, errorResponse, healthResponse, rateResponse, ratesResponse, readyResponse, statusResponse } from './schemas.js';

async function requireRate(service: RatesService, currency: string): Promise<ServedRate> {
  const { rate, unavailable } = await service.getRate(currency);
  if (rate) return rate;
  if (unavailable === 'expired') {
    throw new ApiError(503, 'RATE_EXPIRED', `The last known rate of ${currency} is too old to use`);
  }
  if (unavailable === 'held') {
    throw new ApiError(503, 'RATE_HELD', `An unusual change of ${currency} is waiting for confirmation`);
  }
  if (SUPPORTED_CURRENCIES.includes(currency)) {
    throw new ApiError(503, 'RATE_UNAVAILABLE', `No rate is currently available for ${currency}`);
  }
  throw new ApiError(404, 'UNSUPPORTED_CURRENCY', `Currency "${currency}" is not supported`);
}

interface ConvertQuery {
  from: string;
  to: string;
  amount: string;
  officialOnly: boolean;
}

export function registerRoutes(app: FastifyInstance, service: RatesService, metrics: Metrics, isDraining: () => boolean): void {
  app.get(
    '/api/rates',
    { schema: { summary: 'All latest rates', response: { 200: ratesResponse, 503: errorResponse } } },
    async () => {
      const rates = await service.getRates();
      return { base: 'ILS', stale: rates.some((r) => r.stale), rates };
    },
  );

  app.get<{ Params: { currency: string } }>(
    '/api/rates/:currency',
    {
      schema: {
        summary: 'Latest rate of one currency',
        params: {
          type: 'object',
          required: ['currency'],
          properties: { currency: { type: 'string', description: 'ISO code, e.g. USD' } },
        },
        response: { 200: rateResponse, 404: errorResponse, 503: errorResponse },
      },
    },
    async (request) => {
      const currency = request.params.currency.toUpperCase();
      return { base: 'ILS', ...(await requireRate(service, currency)) };
    },
  );

  app.get<{ Querystring: ConvertQuery }>(
    '/api/convert',
    {
      schema: {
        summary: 'Convert an amount between ILS and another currency',
        querystring: {
          type: 'object',
          required: ['from', 'to', 'amount'],
          properties: {
            from: { type: 'string', description: 'E.g. ILS' },
            to: { type: 'string', description: 'E.g. USD' },
            amount: { type: 'string', description: 'E.g. 1250.50' },
            officialOnly: { type: 'boolean', default: false, description: 'Refuse a rate that is not from BOI' },
          },
        },
        response: { 200: conversionResponse, 400: errorResponse, 404: errorResponse, 503: errorResponse },
      },
    },
    async (request, reply) => {
      const { amount, officialOnly } = request.query;
      const from = request.query.from.toUpperCase();
      const to = request.query.to.toUpperCase();
      if ((from === 'ILS') === (to === 'ILS')) {
        throw new ApiError(400, 'UNSUPPORTED_PAIR', 'Exactly one of the currencies must be ILS');
      }
      if (!isValidAmount(amount, from)) {
        throw new ApiError(
          400,
          'INVALID_AMOUNT',
          `The amount must be positive, with up to 12 digits and ${decimalsOf(from)} decimals`,
        );
      }

      const rate = await requireRate(service, from === 'ILS' ? to : from);
      if (officialOnly && rate.status === 'backup') {
        throw new ApiError(503, 'RATE_NOT_OFFICIAL', 'Only a backup rate is available');
      }
      const result = convertAmount(amount, to, rate.rate);
      if (Number(result) === 0) {
        throw new ApiError(400, 'AMOUNT_TOO_SMALL', 'The result rounds to zero');
      }

      const conversion = { conversionId: randomUUID(), from, to, amount, result, rate };
      // The record of which rate a deposit used.
      request.log.info(conversion, 'Conversion');
      metrics.countConversion(rate.status);
      reply.header('cache-control', 'no-store');
      return conversion;
    },
  );

  app.get(
    '/api/status',
    { schema: { summary: 'Data status, for the UI', response: { 200: statusResponse } } },
    async () => service.status(),
  );

  // For load balancers: an instance that can't convert should not receive requests. A held change is
  // different: it is a decision, and another instance that didn't see the change must not bypass it.
  app.get(
    '/ready',
    { schema: { summary: 'Whether this instance should receive requests', response: { 200: readyResponse, 503: readyResponse } } },
    async (_request, reply) => {
      const { initialized, unavailable } = service.status();
      const ready =
        initialized &&
        !isDraining() &&
        !unavailable.some((u) => u.reason !== 'held' && (REQUIRED_CURRENCIES as readonly string[]).includes(u.currency));
      return reply.code(ready ? 200 : 503).send({ ready });
    },
  );

  // 200 whenever the process is alive: restarting us wouldn't fix an upstream outage.
  app.get(
    '/health',
    { schema: { summary: 'Process health and data status', response: { 200: healthResponse } } },
    async () => ({ status: 'ok', rates: service.status() }),
  );
}
