import { discoveryMapProviderChain, selectDiscoveryProvider } from './provider-selection';
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
