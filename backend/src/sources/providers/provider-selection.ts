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

/**
 * Phase Q — ordered map-provider chain for one discovery execution.
 * Selected SOURCE_PROVIDER runs first; other configured map providers follow
 * (Google Places before OpenStreetMap when both are fallbacks). Fake stays alone.
 * Web search remains a separate refill stage after map providers.
 */
export function discoveryMapProviderChain(
  nodeEnv: string,
  providerName: string,
  google: SourceProvider,
  osm: SourceProvider,
  fake: SourceProvider,
): SourceProvider[] {
  const selected = providerName || 'google_places';
  const primary = selectDiscoveryProvider(nodeEnv, selected, google, osm, fake);
  if (primary.metadata().synthetic) return [primary];

  const chain: SourceProvider[] = [primary];
  const pushIfConfigured = (provider: SourceProvider) => {
    if (chain.some((entry) => entry.providerName() === provider.providerName())) return;
    if (!provider.health().configured) return;
    chain.push(provider);
  };

  // Preferred fallback order among additional map providers: Google Places, then OSM.
  if (selected === 'osm') {
    pushIfConfigured(google);
  } else if (selected === 'google_places') {
    pushIfConfigured(osm);
  } else {
    pushIfConfigured(google);
    pushIfConfigured(osm);
  }
  return chain;
}
