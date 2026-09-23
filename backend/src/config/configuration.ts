export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',

  port: parseInt(process.env.PORT ?? '3000', 10),

  apiPrefix: process.env.API_PREFIX ?? 'api/v1',

  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://localhost:5173',

  throttler: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },

  outbound: {
    timeoutMs: parseInt(process.env.OUTBOUND_TIMEOUT_MS ?? '10000', 10),
    retries: parseInt(process.env.OUTBOUND_RETRIES ?? '2', 10),
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
  },
});

export function validateEnvironment(config: Record<string, unknown>) {
  const required = ['DATABASE_URL', 'REDIS_URL'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const port = Number(config.PORT ?? 3000);
  const throttlerLimit = Number(config.THROTTLE_LIMIT ?? 100);
  const throttlerTtl = Number(config.THROTTLE_TTL ?? 60000);
  const nodeEnv = typeof config.NODE_ENV === 'string' ? config.NODE_ENV : 'development';
  const corsOrigin = typeof config.CORS_ORIGIN === 'string'
    ? config.CORS_ORIGIN
    : 'http://localhost:3000,http://localhost:5173';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (!Number.isInteger(throttlerLimit) || throttlerLimit < 1) {
    throw new Error('THROTTLE_LIMIT must be a positive integer');
  }

  if (!Number.isInteger(throttlerTtl) || throttlerTtl < 1) {
    throw new Error('THROTTLE_TTL must be a positive integer');
  }

  if (nodeEnv === 'production' && corsOrigin === '*') {
    throw new Error('CORS_ORIGIN cannot be "*" in production');
  }

  return config;
}