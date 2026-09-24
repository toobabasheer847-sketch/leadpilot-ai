import { selectDiscoveryProvider } from './provider-selection';
import type { SourceProvider } from '../types/source.types';

const google = { name: 'google_places' } as SourceProvider;
const fake = { name: 'fake_source' } as SourceProvider;

describe('selectDiscoveryProvider', () => {
  it('selects Google Places from configuration', () => {
    expect(selectDiscoveryProvider('production', 'google_places', google, fake)).toBe(google);
    expect(selectDiscoveryProvider('development', '', google, fake)).toBe(google);
  });

  it('allows the fake provider only outside production', () => {
    expect(selectDiscoveryProvider('test', 'fake', google, fake)).toBe(fake);
    expect(() => selectDiscoveryProvider('production', 'fake', google, fake)).toThrow(/SOURCE_PROVIDER=fake/);
    expect(() => selectDiscoveryProvider('production', 'fake_source', google, fake)).toThrow(/SOURCE_PROVIDER=fake/);
  });

  it('rejects an unknown provider instead of silently substituting one', () => {
    expect(() => selectDiscoveryProvider('development', 'unlisted', google, fake)).toThrow(/Unsupported SOURCE_PROVIDER/);
  });
});
