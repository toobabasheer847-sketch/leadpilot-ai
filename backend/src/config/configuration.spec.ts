import configuration, { validateEnvironment } from './configuration';

describe('configuration', () => {
  it('loads foundation settings', () => {
    const originalEnvironment = process.env;
    process.env = {
      ...originalEnvironment,
      DATABASE_URL: 'postgresql://localhost/leadpilot',
      REDIS_URL: 'redis://localhost:6379',
      OPENROUTER_API_KEY: 'secret-value',
    };

    try {
      const result = configuration();

      expect(result.database.url).toBe(process.env.DATABASE_URL);
      expect(result.openRouter.apiKey).toBe('secret-value');
    } finally {
      process.env = originalEnvironment;
    }
  });

  it('rejects missing required infrastructure settings', () => {
    expect(() => validateEnvironment({ PORT: '3000' })).toThrow(
      'Missing required environment variables: DATABASE_URL, REDIS_URL',
    );
  });

  it('rejects wildcard CORS in production', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost/leadpilot',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGIN: '*',
    })).toThrow('CORS_ORIGIN cannot be "*" in production');
  });
});
