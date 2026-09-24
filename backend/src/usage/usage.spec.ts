import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { UsageLimitExceededException } from './usage.errors';
import { ProviderUsageService } from './provider-usage.service';

describe('usage controls', () => {
  it('returns a machine-readable 429 quota response without internal details', () => {
    const error = new UsageLimitExceededException('EXPORT_DAILY', 0, new Date('2026-09-25T00:00:00.000Z'));
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      statusCode: 429,
      code: 'USAGE_LIMIT_EXCEEDED',
      message: 'Usage limit exceeded',
      limit: 'EXPORT_DAILY',
      remaining: 0,
      resetAt: '2026-09-25T00:00:00.000Z',
    });
  });

  it('uses the atomic Redis counter result for distributed rate decisions', async () => {
    const service = new RedisService({ get: () => 'redis://localhost:6379' } as ConfigService);
    const client = {
      eval: async () => 3,
      ttl: async () => 42,
      disconnect: () => undefined,
    };
    (service as unknown as { client: typeof client }).client = client;
    const result = await service.consumeFixedWindow('test-key', 2, 60);
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(3);
    expect(result.resetAt.getTime()).toBeGreaterThan(Date.now());
    await service.onModuleDestroy();
  });

  it('estimates provider cost only from configured pricing', () => {
    const providerUsage = new ProviderUsageService(
      {} as never,
      { get: (key: string) => key === 'usage.pricing' ? { provider_a: { unitCost: 0.02 } } : undefined } as never,
    );

    expect(providerUsage.estimateCost('provider_a', 3)).toEqual({ cost: 0.06, status: 'ESTIMATED' });
    expect(providerUsage.estimateCost('unknown_provider', 3)).toEqual({ cost: null, status: 'UNKNOWN' });
  });
});
