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
  readonly terminal: boolean;

  constructor(public readonly code: ProviderErrorCode, message: string, terminal = false) {
    super(message);
    this.name = SourceProviderError.name;
    this.terminal = terminal;
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  return error instanceof SourceProviderError && RETRYABLE_PROVIDER_ERRORS.has(error.code);
}

export function isTerminalProviderError(error: unknown): boolean {
  return error instanceof SourceProviderError && (error.terminal || TERMINAL_PROVIDER_ERRORS.has(error.code));
}

/**
 * Provider-level faults that must not abort the whole discovery stage.
 * Phase Q: quota and auth also fall through so other configured providers can continue.
 * Bull job terminality remains governed by isTerminalProviderError / error.terminal.
 * PROVIDER_UNKNOWN_ERROR stays non-recoverable so providers can still surface fatal payloads.
 */
export function isRecoverableDiscoveryError(error: unknown): error is SourceProviderError {
  return error instanceof SourceProviderError && (
    error.code === 'PROVIDER_RATE_LIMITED'
    || error.code === 'PROVIDER_TIMEOUT'
    || error.code === 'PROVIDER_UNAVAILABLE'
    || error.code === 'PROVIDER_NOT_CONFIGURED'
    || error.code === 'PROVIDER_INVALID_REQUEST'
    || error.code === 'PROVIDER_QUOTA_EXCEEDED'
    || error.code === 'PROVIDER_AUTH_ERROR'
  );
}
