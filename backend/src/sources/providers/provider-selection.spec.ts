import { selectDiscoveryProvider } from './provider-selection';
import type { SourceProvider } from '../types/source.types';

const google = { name: 'google_places' } as SourceProvider;
const osm = { name: 'osm' } as SourceProvider;
const fake = { name: 'fake_source' } as SourceProvider;

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
