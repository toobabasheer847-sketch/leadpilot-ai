import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './observability/metrics.service';
import { RequestContextService } from './observability/request-context.service';
import { StructuredLoggerService } from './observability/structured-logger.service';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContextService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  use(request: Request, response: Response, next: NextFunction) {
    const requestId = this.validId(request.header(REQUEST_ID_HEADER)) ?? randomUUID();
    const correlationId = this.validId(request.header(CORRELATION_ID_HEADER)) ?? requestId;

    response.locals.requestId = requestId;
    response.locals.correlationId = correlationId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    const startedAt = Date.now();
    response.on('finish', () => {
      const route = request.route?.path ?? request.baseUrl ?? 'unknown';
      this.metrics.increment('http_requests_total', { method: request.method, route, status: String(response.statusCode) });
      this.metrics.observe('http_request_duration_ms', Date.now() - startedAt, { method: request.method, route });
      this.logger.info('http.request.completed', { method: request.method, route, status: response.statusCode, durationMs: Date.now() - startedAt });
    });
    this.context.run({ requestId, correlationId }, next);
  }

  private validId(value: string | undefined) {
    return value && SAFE_ID.test(value) ? value : undefined;
  }
}
