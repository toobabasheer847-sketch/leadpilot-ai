export type WebSearchErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_HTTP_ERROR'
  | 'INVALID_PROVIDER_RESPONSE';

export class WebSearchError extends Error {
  readonly stage = 'WEBSITE_DISCOVERY';

  constructor(
    readonly errorCode: WebSearchErrorCode,
    readonly provider: string,
    readonly operation: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'WebSearchError';
  }
}

export function isWebSearchError(error: unknown): error is WebSearchError {
  return error instanceof WebSearchError;
}
