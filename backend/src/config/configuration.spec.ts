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

  it('allows the OpenStreetMap provider and rejects an insecure Overpass URL', () => {
    expect(validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      SOURCE_PROVIDER: 'osm',
      OVERPASS_API_URL: 'https://overpass-api.de/api/interpreter',
      OVERPASS_TIMEOUT_MS: '30000',
      OVERPASS_MAX_RESULTS: '100',
      OPENROUTER_API_KEY: 'present',
      OPENROUTER_MODEL: 'configured-model',
    })).toEqual(expect.objectContaining({ SOURCE_PROVIDER: 'osm' }));
    expect(() => validateEnvironment({
      ...base,
      OVERPASS_API_URL: 'http://overpass.example/api',
    })).toThrow(/OVERPASS_API_URL/);
  });

  it('requires OpenRouter key and model together without accepting a blank value', () => {
    expect(validateEnvironment({ ...base, OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' })).toEqual(expect.objectContaining(base));
    expect(() => validateEnvironment({ ...base, OPENROUTER_API_KEY: 'present' })).toThrow(/must both be set/);
    expect(() => validateEnvironment({ ...base, OPENROUTER_MODEL: 'configured-model' })).toThrow(/must both be set/);
    expect(() => validateEnvironment({ ...base, OPENROUTER_API_KEY: '   ', OPENROUTER_MODEL: 'configured-model' })).toThrow(/non-empty/);
    expect(() => validateEnvironment({ ...base, OPENROUTER_BASE_URL: 'http://openrouter.example/api/v1', OPENROUTER_API_KEY: 'present', OPENROUTER_MODEL: 'configured-model' })).toThrow(/OPENROUTER_BASE_URL/);
    expect(() => validateEnvironment({ ...base, OPENROUTER_TIMEOUT_MS: '50', OPENROUTER_API_KEY: 'present', OPENROUTER_MODEL: 'configured-model' })).toThrow(/OPENROUTER_TIMEOUT_MS/);
    expect(() => validateEnvironment({ ...base, OPENROUTER_RETRIES: '9', OPENROUTER_API_KEY: 'present', OPENROUTER_MODEL: 'configured-model' })).toThrow(/OPENROUTER_RETRIES/);
  });

  it('accepts Tavily without a key and rejects Brave or an insecure search URL', () => {
    expect(validateEnvironment({ ...base, WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: '' })).toEqual(expect.objectContaining({ WEB_SEARCH_PROVIDER: 'tavily' }));
    expect(() => validateEnvironment({ ...base, WEB_SEARCH_PROVIDER: 'brave' })).toThrow(/Unsupported WEB_SEARCH_PROVIDER: brave/);
    expect(() => validateEnvironment({ ...base, TAVILY_API_URL: 'http://api.tavily.com/search' })).toThrow(/TAVILY_API_URL/);
  });
});
