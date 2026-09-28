import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisEndpoint } from './redis-endpoint';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(configService: ConfigService) {
    const redisUrl = configService.get<string>('redis.url') || 'redis://127.0.0.1:6379';
    this.client = new Redis({
      ...redisEndpoint(redisUrl),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 10_000,
      retryStrategy(times: number) {
        return Math.min(times * 500, 5_000);
      },
    });
    this.client.on('error', () => {
      this.logger.warn('Redis client reported an error');
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async consumeFixedWindow(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; count: number; resetAt: Date }> {
    const resetAt = new Date(Date.now() + windowSeconds * 1000);
    try {
      const count = Number(await this.client.eval(
        'local current = redis.call("INCR", KEYS[1]); if current == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]); end; return current',
        1,
        key,
        windowSeconds,
      ));
      const ttl = await this.client.ttl(key);
      return { allowed: count <= limit, count, resetAt: new Date(Date.now() + Math.max(ttl, 0) * 1000) };
    } catch {
      return { allowed: true, count: 0, resetAt };
    }
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }
}
