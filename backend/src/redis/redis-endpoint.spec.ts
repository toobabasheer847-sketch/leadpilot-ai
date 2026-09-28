import { normalizeRedisHost } from './redis-endpoint';

describe('redis endpoint', () => {
  it('uses the IPv4 loopback address for localhost so a broken IPv6 forwarder is not selected', () => {
    expect(normalizeRedisHost('localhost')).toBe('127.0.0.1');
    expect(normalizeRedisHost('::1')).toBe('127.0.0.1');
    expect(normalizeRedisHost('')).toBe('127.0.0.1');
    expect(normalizeRedisHost('redis.internal')).toBe('redis.internal');
  });
});
