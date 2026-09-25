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
      const details = providerFailureDetails(error);
      this.metrics.observe('provider_latency_ms', durationMs, { provider, operation });
      this.metrics.increment('provider_requests_total', { provider, operation, status: failureCategory });
      this.logger.warn('provider.request.failed', {
        provider: details.provider ?? provider,
        operation: details.operation ?? operation,
        durationMs,
        failureCategory,
        ...(details.errorCode ? { stage: details.stage, errorCode: details.errorCode, retryable: details.retryable } : {}),
        message: details.message,
      });
      throw error;
    }
  }
}

function providerFailureDetails(error: unknown): { provider?: string; operation?: string; stage?: string; errorCode?: string; retryable?: boolean; message: string } {
  const record = error instanceof Error ? error as Error & { provider?: unknown; operation?: unknown; stage?: unknown; errorCode?: unknown; retryable?: unknown } : undefined;
  const structured = record?.name === 'WebsiteDiscoveryError' || record?.name === 'WebSearchError';
  return {
    ...(structured && typeof record?.provider === 'string' ? { provider: record.provider } : {}),
    ...(structured && typeof record?.operation === 'string' ? { operation: record.operation } : {}),
    ...(structured && typeof record?.stage === 'string' ? { stage: record.stage } : {}),
    ...(structured && typeof record?.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(structured && typeof record?.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    message: safeProviderLogMessage(record?.message),
  };
}

function safeProviderLogMessage(message?: string): string {
  const first = message?.split('\n')[0]?.trim() || 'Provider request failed.';
  if (first.length > 300 || /at\s+\S+\s+\(|postgres|redis:|api[_-]?key|bearer |authorization|database_url|secret/i.test(first)) return 'Provider request failed.';
  return first;
}