import type { FastifyError, FastifyInstance } from 'fastify';
import { NoRatesError } from '../rates/service.js';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const body = (code: string, message: string) => ({ error: { code, message } });

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(body('NOT_FOUND', 'Route not found')));

  app.setErrorHandler<FastifyError | ApiError | NoRatesError>((error, request, reply) => {
    if (error instanceof NoRatesError) {
      return reply.code(503).send(body('NO_DATA', 'Exchange rates are currently unavailable'));
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(body(error.code, error.message));
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send(body('BAD_REQUEST', error.message));
    }
    // Internal details go to the log, not to the caller.
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send(body('INTERNAL_ERROR', 'Internal server error'));
  });
}
