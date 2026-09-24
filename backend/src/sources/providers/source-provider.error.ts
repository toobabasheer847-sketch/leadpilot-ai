export type SourceProviderErrorCode = 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'AUTHENTICATION' | 'INVALID_REQUEST' | 'PROVIDER_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'MALFORMED_RESPONSE';

export class SourceProviderError extends Error {
  constructor(public readonly code: SourceProviderErrorCode, message: string) {
    super(message);
    this.name = SourceProviderError.name;
  }
}