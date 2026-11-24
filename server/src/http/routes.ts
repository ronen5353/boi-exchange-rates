import type { FastifyInstance } from 'fastify';
import { SUPPORTED_CURRENCIES } from '../domain/rates.js';
import { NoRatesError, type RatesService } from '../rates/service.js';
import { ApiError } from './errors.js';
import { errorResponse, healthResponse, rateResponse, ratesResponse } from './schemas.js';

export function registerRoutes(app: FastifyInstance, service: RatesService): void {
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
      const isSupported = SUPPORTED_CURRENCIES.includes(currency);
      let rate;
      try {
        rate = (await service.getRates()).find((r) => r.currency === currency);
      } catch (error) {
        // An unknown currency is 404 even during an outage.
        if (!(error instanceof NoRatesError) || isSupported) throw error;
      }
      if (rate) return { base: 'ILS', ...rate };
      if (isSupported) {
        throw new ApiError(503, 'RATE_UNAVAILABLE', `No rate is currently available for ${currency}`);
      }
      throw new ApiError(404, 'UNSUPPORTED_CURRENCY', `Currency "${currency}" is not supported`);
    },
  );

  // 200 whenever the process is alive: restarting us wouldn't fix an upstream outage.
  app.get(
    '/health',
    { schema: { summary: 'Process health and data status', response: { 200: healthResponse } } },
    async () => ({ status: 'ok', rates: service.status() }),
  );
}
