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
