import { isWebSearchError } from './web-search.error';

export type WebsiteDiscoveryErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_4XX'
  | 'PROVIDER_5XX'
  | 'INVALID_RESPONSE';

export class WebsiteDiscoveryError extends Error {
  readonly stage = 'WEBSITE_DISCOVERY';

  constructor(
    readonly errorCode: WebsiteDiscoveryErrorCode,
    readonly provider: string,
    readonly operation: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'WebsiteDiscoveryError';
  }
}

export const PLAN_LIMIT_FALLBACK_MESSAGE =
  '[PlanLimitFallback] Web search provider limit hit; skipping active enrichment step while keeping discovered data.';

export function isPlanLimitFallbackError(error: unknown): boolean {
  const values = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const response = values.response && typeof values.response === 'object'
    ? values.response as Record<string, unknown>
    : {};
  const status = [
    values.status,
    values.statusCode,
    response.status,
    typeof values.getStatus === 'function' ? (values.getStatus as () => unknown)() : undefined,
  ].find((value): value is number => typeof value === 'number');
  if (status === 403 || status === 429) return true;
  const message = error instanceof Error
    ? error.message
    : typeof values.message === 'string' ? values.message : String(error ?? '');
  return /plan\s+limit\s+exceeded|pay-as-you-go\s+limit\s+exceeded|rate\s*limit|http\s*(?:status\s*)?(?:403|429)|status\s*(?:403|429)|\b(?:403|429)\b/i.test(message);
}

export function isWebsiteDiscoveryError(error: unknown): error is WebsiteDiscoveryError {
  return error instanceof WebsiteDiscoveryError;
}

export function safeProviderMessage(message: string): string {
  const first = message.split('\n')[0]?.trim() || 'Website discovery failed.';
  if (first.length > 300 || /at\s+\S+\s+\(|postgres|redis:|api[_-]?key|bearer |authorization|database_url|secret/i.test(first)) {
    return 'Website discovery failed.';
  }
  return first;
}

export function websiteFailureLog(error: unknown): {
  stage: string;
  errorCode: string;
  provider: string;
  operation: string;
  retryable: boolean;
  message: string;
} {
  if (isWebsiteDiscoveryError(error) || isWebSearchError(error)) {
    return {
      stage: error.stage,
      errorCode: error.errorCode,
      provider: error.provider,
      operation: error.operation,
      retryable: error.retryable,
      message: safeProviderMessage(error.message),
    };
  }
  return {
    stage: 'WEBSITE_DISCOVERY',
    errorCode: 'INTERNAL_ERROR',
    provider: 'website',
    operation: 'enrich',
    retryable: false,
    message: safeProviderMessage(error instanceof Error ? error.message : 'Website discovery failed.'),
  };
}
