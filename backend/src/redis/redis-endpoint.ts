export function normalizeRedisHost(hostname: string | undefined): string {
  const host = (hostname || '').trim();
  if (!host || host === 'localhost' || host === '::1') return '127.0.0.1';
  return host;
}

export function redisEndpoint(redisUrl: string): { host: string; port: number; username?: string; password?: string } {
  const url = new URL(redisUrl);
  return {
    host: normalizeRedisHost(url.hostname),
    port: parseInt(url.port || '6379', 10),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}
