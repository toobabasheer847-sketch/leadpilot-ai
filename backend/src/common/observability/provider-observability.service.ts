import { Injectable } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { StructuredLoggerService } from './structured-logger.service';

export interface ProviderOperationResult<T> {
  value: T;
  httpStatus?: number;
  retryCount?: number;
}

@Injectable()
export class ProviderObservabilityService {
  constructor(
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async track<T>(provider: string, operation: string, callback: () => Promise<ProviderOperationResult<T>>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await callback();
      const durationMs = Date.now() - startedAt;
      this.metrics.observe('provider_latency_ms', durationMs, { provider, operation });
      this.metrics.increment('provider_requests_total', { provider, operation, status: 'success' });
      this.logger.info('provider.request.completed', { provider, operation, durationMs, httpStatus: result.httpStatus, retryCount: result.retryCount ?? 0 });
      return result.value;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const failureCategory = error instanceof Error && /timeout|abort/i.test(error.message) ? 'timeout' : 'provider';
      this.metrics.observe('provider_latency_ms', durationMs, { provider, operation });
      this.metrics.increment('provider_requests_total', { provider, operation, status: failureCategory });
      this.logger.warn('provider.request.failed', { provider, operation, durationMs, failureCategory });
      throw error;
    }
  }
}