import type { SourceProvider } from '../types/source.types';

export function selectDiscoveryProvider(nodeEnv: string, providerName: string, google: SourceProvider, osm: SourceProvider, fake: SourceProvider): SourceProvider {
  const selected = providerName || 'google_places';
  if (selected === 'fake' || selected === 'fake_source') {
    if (nodeEnv === 'production') throw new Error('SOURCE_PROVIDER=fake is not allowed in production');
    return fake;
  }
  if (selected === 'google_places') return google;
  if (selected === 'osm') return osm;
  throw new Error(`Unsupported SOURCE_PROVIDER: ${selected}`);
}
