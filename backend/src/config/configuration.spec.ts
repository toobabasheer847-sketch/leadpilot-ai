import { validateEnvironment } from './configuration';

describe('environment validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://localhost/leadpilot',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(32),
    NODE_ENV: 'development',
  };

  it('accepts a development configuration without provider keys', () => {
    expect(validateEnvironment({ ...base })).toEqual(expect.objectContaining(base));
  });

  it('reports missing production provider configuration', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production' })).toThrow(/GOOGLE_PLACES_API_KEY/);
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      SOURCE_PROVIDER: 'fake',
      GOOGLE_PLACES_API_KEY: 'present',
      OPENROUTER_API_KEY: 'present',
      OPENROUTER_MODEL: 'model',
    })).toThrow(/SOURCE_PROVIDER=fake/);
  });
});
