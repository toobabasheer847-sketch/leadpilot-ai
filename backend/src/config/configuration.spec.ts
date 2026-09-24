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

  it('allows production website research without Google Places and rejects the fake provider', () => {
    expect(validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      SOURCE_PROVIDER: 'google_places',
      OPENROUTER_API_KEY: 'present',
      OPENROUTER_MODEL: 'configured-model',
    })).toEqual(expect.objectContaining({ NODE_ENV: 'production', SOURCE_PROVIDER: 'google_places' }));
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production' })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      SOURCE_PROVIDER: 'fake',
      OPENROUTER_API_KEY: 'present',
      OPENROUTER_MODEL: 'configured-model',
    })).toThrow(/SOURCE_PROVIDER=fake/);
  });
});
