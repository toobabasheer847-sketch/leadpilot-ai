import { discoveryMapProviderChain, resolveDiscoveryProvider, selectDiscoveryProvider } from './provider-selection';
import type { SourceProvider } from '../types/source.types';

const google = {
  name: 'google_places',
  providerName: () => 'google_places',
  metadata: () => ({ provider: 'google_places', sourceType: 'google_places', synthetic: false }),
  health: () => ({ name: 'google_places', configured: true, enabled: true }),
} as SourceProvider;
const osm = {
  name: 'osm',
  providerName: () => 'osm',
  metadata: () => ({ provider: 'osm', sourceType: 'osm', synthetic: false }),
  health: () => ({ name: 'osm', configured: true, enabled: true }),
} as SourceProvider;
const fake = {
  name: 'fake_source',
  providerName: () => 'fake',
  metadata: () => ({ provider: 'fake', sourceType: 'fake', synthetic: true }),
  health: () => ({ name: 'fake', configured: true, enabled: true }),
} as SourceProvider;
const openRouter = {
  name: 'openrouter',
  providerName: () => 'openrouter',
  metadata: () => ({ provider: 'openrouter', sourceType: 'openrouter', synthetic: false }),
  health: () => ({ name: 'openrouter', configured: true, enabled: true }),
} as SourceProvider;

describe('selectDiscoveryProvider', () => {
  it('selects Google Places from configuration', () => {
    expect(selectDiscoveryProvider('production', 'google_places', google, osm, fake)).toBe(google);
    expect(selectDiscoveryProvider('development', '', google, osm, fake)).toBe(google);
  });

  it('selects the OpenStreetMap provider when SOURCE_PROVIDER=osm', () => {
    expect(selectDiscoveryProvider('development', 'osm', google, osm, fake)).toBe(osm);
    expect(selectDiscoveryProvider('production', 'osm', google, osm, fake)).toBe(osm);
    expect(selectDiscoveryProvider('production', 'osm', google, osm, fake)).not.toBe(fake);
    expect(selectDiscoveryProvider('production', 'osm', google, osm, fake)).not.toBe(google);
  });

  it('selects the OpenRouter web discovery provider explicitly', () => {
    expect(selectDiscoveryProvider('development', 'openrouter', google, osm, fake, openRouter)).toBe(openRouter);
    expect(resolveDiscoveryProvider('development', 'openrouter', google, osm, fake, undefined, openRouter)).toBe(openRouter);
    expect(discoveryMapProviderChain('development', 'openrouter', google, osm, fake, undefined, openRouter))
      .toEqual([openRouter]);
    expect(() => selectDiscoveryProvider('development', 'openrouter', google, osm, fake)).toThrow(/openrouter is not available/);
  });

  it('allows the fake provider only outside production', () => {
    expect(selectDiscoveryProvider('test', 'fake', google, osm, fake)).toBe(fake);
    expect(() => selectDiscoveryProvider('production', 'fake', google, osm, fake)).toThrow(/SOURCE_PROVIDER=fake/);
    expect(() => selectDiscoveryProvider('production', 'fake_source', google, osm, fake)).toThrow(/SOURCE_PROVIDER=fake/);
  });

  it('rejects an unknown provider instead of silently substituting one', () => {
    expect(() => selectDiscoveryProvider('development', 'unlisted', google, osm, fake)).toThrow(/Unsupported SOURCE_PROVIDER: unlisted/);
    expect(() => selectDiscoveryProvider('development', 'OSM', google, osm, fake)).toThrow(/Unsupported SOURCE_PROVIDER: OSM/);
  });
});

describe('discoveryMapProviderChain', () => {
  it('puts the selected provider first and configured fallbacks after', () => {
    expect(discoveryMapProviderChain('development', 'osm', google, osm, fake).map((p) => p.providerName()))
      .toEqual(['osm', 'google_places']);
    expect(discoveryMapProviderChain('development', 'google_places', google, osm, fake).map((p) => p.providerName()))
      .toEqual(['google_places', 'osm']);
  });

  it('keeps fake alone and skips unconfigured fallbacks', () => {
    const unconfiguredGoogle = {
      ...google,
      health: () => ({ name: 'google_places', configured: false, enabled: false }),
    } as SourceProvider;
    expect(discoveryMapProviderChain('test', 'fake', google, osm, fake)).toEqual([fake]);
    expect(discoveryMapProviderChain('development', 'osm', unconfiguredGoogle, osm, fake).map((p) => p.providerName()))
      .toEqual(['osm']);
  });
});

describe('resolveDiscoveryProvider', () => {
  it('resolves known providers without warnings', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDiscoveryProvider('development', 'google_places', google, osm, fake)).toBe(google);
    expect(resolveDiscoveryProvider('development', 'osm', google, osm, fake)).toBe(osm);
    expect(resolveDiscoveryProvider('test', 'fake', google, osm, fake)).toBe(fake);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls back to osm and logs a warning when SOURCE_PROVIDER is unsupported (e.g. "serpapi")', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveDiscoveryProvider('development', 'serpapi', google, osm, fake);
    expect(result).toBe(osm);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SOURCE_PROVIDER="serpapi"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('osm'));
    warnSpy.mockRestore();
  });

  it('mentions tavily in the warning when TAVILY_API_KEY is present', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDiscoveryProvider('development', 'serpapi', google, osm, fake, 'tvly-test-key');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tavily'));
    warnSpy.mockRestore();
  });

  it('falls back to osm for an empty/blank provider string', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Empty string falls through to google_places default (no warning)
    expect(resolveDiscoveryProvider('development', '', google, osm, fake)).toBe(google);
    warnSpy.mockRestore();
  });

  it('still throws for fake provider in production (security boundary preserved)', () => {
    expect(() => resolveDiscoveryProvider('production', 'fake', google, osm, fake)).toThrow(/SOURCE_PROVIDER=fake/);
  });
});
