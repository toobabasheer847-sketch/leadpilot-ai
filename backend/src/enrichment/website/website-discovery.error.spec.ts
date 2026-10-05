import {
  isPlanLimitFallbackError,
  PLAN_LIMIT_FALLBACK_MESSAGE,
} from './website-discovery.error';

describe('website enrichment plan-limit fallback', () => {
  it.each([
    ['plan limit exceeded', new Error('Web search plan limit exceeded.')],
    ['rate limit', new Error('Web search provider rate limit reached.')],
    ['HTTP 429', new Error('Provider returned HTTP 429.')],
    ['HTTP 403', new Error('Provider returned HTTP 403.')],
    ['status code', Object.assign(new Error('Request failed'), { statusCode: 429 })],
    ['Nest HTTP status', { getStatus: () => 403, message: 'Forbidden' }],
  ])('recognizes %s as a graceful limit fallback', (_label, error) => {
    expect(isPlanLimitFallbackError(error)).toBe(true);
  });

  it('does not treat unrelated failures as provider plan limits', () => {
    expect(isPlanLimitFallbackError(new Error('Website parser failed'))).toBe(false);
    expect(PLAN_LIMIT_FALLBACK_MESSAGE).toContain('keeping discovered data');
  });
});
