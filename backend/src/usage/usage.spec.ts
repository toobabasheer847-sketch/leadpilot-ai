import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { UsageLimitExceededException } from './usage.errors';
import { ProviderUsageService } from './provider-usage.service';
import { UsageService } from './usage.service';
import type { UsageLimits } from './types/usage.types';

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

  it('allows batch VERIFICATION enqueue up to RATE_LIMIT_VERIFICATION_PER_MINUTE (default 500)', async () => {
    const counts = new Map<string, number>();
    const redis = {
      consumeFixedWindow: jest.fn(async (key: string, limit: number) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return { allowed: next <= limit, count: next, resetAt: new Date(Date.now() + 60_000) };
      }),
    };
    const defaults: UsageLimits = {
      requestsPerMinute: 100,
      requestsPerHour: 10_000,
      requestsPerDay: 50_000,
      aiRequestsPerMinute: 20,
      aiRequestsPerDay: 500,
      dailySearchLimit: 100,
      dailyExportLimit: 25,
      dailyAiLimit: 500,
      maxLeadsPerSearch: 1000,
      maxExportRows: 10000,
    };
    const config = {
      get: (key: string) => {
        if (key === 'usage') return defaults;
        if (key === 'usage.verificationRequestsPerMinute') return 500;
        return undefined;
      },
    } as ConfigService;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: async () => undefined }),
    };
    const usage = new UsageService(db as never, redis as never, config);

    for (let i = 0; i < 500; i += 1) {
      await expect(usage.checkRequestRate('org-1', undefined, 'VERIFICATION')).resolves.toBeUndefined();
    }
    await expect(usage.checkRequestRate('org-1', undefined, 'VERIFICATION')).rejects.toBeInstanceOf(UsageLimitExceededException);

    const minuteCalls = redis.consumeFixedWindow.mock.calls.filter((call) => String(call[0]).endsWith(':minute'));
    expect(minuteCalls[0][1]).toBe(500);
    expect(minuteCalls).toHaveLength(501);
  });

  it('keeps the global 100/min limit for non-verification operations', async () => {
    const redis = {
      consumeFixedWindow: jest.fn(async () => ({
        allowed: true,
        count: 1,
        resetAt: new Date(Date.now() + 60_000),
      })),
    };
    const defaults: UsageLimits = {
      requestsPerMinute: 100,
      requestsPerHour: 1000,
      requestsPerDay: 5000,
      aiRequestsPerMinute: 20,
      aiRequestsPerDay: 500,
      dailySearchLimit: 100,
      dailyExportLimit: 25,
      dailyAiLimit: 500,
      maxLeadsPerSearch: 1000,
      maxExportRows: 10000,
    };
    const config = {
      get: (key: string) => (key === 'usage' ? defaults : key === 'usage.verificationRequestsPerMinute' ? 500 : undefined),
    } as ConfigService;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: async () => undefined }),
    };
    const usage = new UsageService(db as never, redis as never, config);
    await usage.checkRequestRate('org-1', undefined, 'DISCOVERY');
    const minuteCall = redis.consumeFixedWindow.mock.calls.find((call) => String(call[0]).endsWith(':minute'));
    expect(minuteCall?.[1]).toBe(100);
  });
});
