export const PROVIDER_ERROR_CODES = [
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_AUTH_ERROR',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_INVALID_REQUEST',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_UNKNOWN_ERROR',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

const RETRYABLE_PROVIDER_ERRORS = new Set<ProviderErrorCode>([
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_UNKNOWN_ERROR',
]);

const TERMINAL_PROVIDER_ERRORS = new Set<string>([
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_AUTH_ERROR',
  'PROVIDER_INVALID_REQUEST',
  'PROVIDER_QUOTA_EXCEEDED',
  'NOT_CONFIGURED',
  'AUTHENTICATION',
  'INVALID_REQUEST',
  'MALFORMED_RESPONSE',
]);

export class SourceProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = SourceProviderError.name;
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  return error instanceof SourceProviderError && RETRYABLE_PROVIDER_ERRORS.has(error.code);
}

export function isTerminalProviderError(error: unknown): boolean {
  return error instanceof SourceProviderError && TERMINAL_PROVIDER_ERRORS.has(error.code);
}
