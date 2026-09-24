import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from './metrics.service';
import { RequestContextService } from './request-context.service';
import { StructuredLoggerService } from './structured-logger.service';
import { CORRELATION_ID_HEADER, RequestIdMiddleware, REQUEST_ID_HEADER } from '../request-id.middleware';

describe('observability', () => {
  it('generates bounded request and correlation IDs and returns them in headers', () => {
    const headers = new Map<string, string>();
    let finished: (() => void) | undefined;
    const response = {
      locals: {},
      setHeader: (name: string, value: string) => headers.set(name, value),
      on: (_event: string, callback: () => void) => { finished = callback; },
      statusCode: 200,
    } as never;
    const metrics = { increment: jest.fn(), observe: jest.fn() } as never;
    const logger = { info: jest.fn() } as never;
    const context = new RequestContextService();
    const middleware = new RequestIdMiddleware(context, metrics, logger);
    const next = jest.fn();

    middleware.use({ method: 'GET', path: '/api/v1/health', header: () => 'bad id with spaces' } as never, response, next);
    finished?.();

    expect(next).toHaveBeenCalledTimes(1);
    expect(headers.get(REQUEST_ID_HEADER)).toMatch(/^[a-f0-9-]{36}$/);
    expect(headers.get(CORRELATION_ID_HEADER)).toBe(headers.get(REQUEST_ID_HEADER));
    expect(metrics.increment).toHaveBeenCalledWith('http_requests_total', expect.any(Object));
  });

  it('redacts credentials and authorization values from structured logs', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const context = new RequestContextService();
    const logger = new StructuredLoggerService(context, { get: () => 'test' } as ConfigService);

    logger.info('test.operation', { apiKey: 'secret', authorization: 'Bearer token', nested: { password: 'secret' }, safeId: 'internal-id' });

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(payload.apiKey).toBe('[REDACTED]');
    expect(payload.authorization).toBe('[REDACTED]');
    expect(payload.nested.password).toBe('[REDACTED]');
    expect(payload.safeId).toBe('internal-id');
    logSpy.mockRestore();
  });

  it('keeps metric labels bounded and sanitized', () => {
    const metrics = new MetricsService();
    metrics.increment('http_requests_total', { route: '/leads/abc?email=private@example.com', method: 'GET' });
    const output = metrics.toPrometheus();
    expect(output).not.toContain('@');
    expect(output).not.toContain('private@example.com');
    expect(output).toContain('http_requests_total');
  });
});