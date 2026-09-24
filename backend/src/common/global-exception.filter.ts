import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { MetricsService } from './observability/metrics.service';
import { StructuredLoggerService } from './observability/structured-logger.service';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly configService: ConfigService = new ConfigService(),
    private readonly structuredLogger?: StructuredLoggerService,
    private readonly metrics?: MetricsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = response.locals.requestId || request.header('x-request-id') || 'unknown';
    const isProduction = this.configService.get('nodeEnv', process.env.NODE_ENV) === 'production';

    if (status >= 500) {
      this.structuredLogger?.error('http.request.failed', { status, method: request.method, route: request.route?.path ?? request.path, errorType: exception instanceof Error ? exception.name : 'UnknownError' });
      this.metrics?.increment('http_errors_total', { method: request.method, status: String(status) });
    }

    const message = status >= 500 && isProduction
      ? 'Internal server error'
      : exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    const errorResponse = exception instanceof HttpException && status < 500 ? exception.getResponse() : undefined;
    response.status(status).json({
      statusCode: status,
      code: status >= 500 ? 'INTERNAL_SERVER_ERROR' : undefined,
      message: errorResponse ?? message,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
      requestId,
    });
  }
}
