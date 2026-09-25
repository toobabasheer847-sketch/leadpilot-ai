import { ConfigService } from '@nestjs/config';
import { DiscoveryProviderRegistry } from './discovery-provider.registry';

function registry(values: Record<string, unknown>) {
  return new DiscoveryProviderRegistry({ get: (key: string, fallback?: unknown) => values[key] ?? fallback } as ConfigService);
}

describe('DiscoveryProviderRegistry', () => {
  it('reports Google Places as unconfigured without returning secrets', () => {
    const status = registry({ nodeEnv: 'development', 'sourceProvider.provider': 'google_places' }).status();
    expect(status.providers).toContainEqual({ name: 'google_places', configured: false, enabled: false });
    expect(JSON.stringify(status)).not.toContain('secret-key');
  });

  it('enables Google Places only when it is selected and configured', () => {
    const status = registry({
      nodeEnv: 'production',
      'sourceProvider.provider': 'google_places',
      'sourceProvider.googlePlacesApiKey': 'secret-key',
      'sourceProvider.googlePlacesBaseUrl': 'https://places.googleapis.com/v1/places:searchText',
    }).status();
    expect(status.providers).toEqual([
      { name: 'google_places', configured: true, enabled: true },
      { name: 'osm', configured: true, enabled: false },
    ]);
    expect(JSON.stringify(status)).not.toContain('secret-key');
  });

  it('enables OpenStreetMap only when it is selected and the endpoint is https', () => {
    const selected = registry({
      nodeEnv: 'development',
      'sourceProvider.provider': 'osm',
      'sourceProvider.overpassApiUrl': 'https://overpass-api.de/api/interpreter',
    }).status();
    expect(selected.providers).toContainEqual({ name: 'osm', configured: true, enabled: true });
    expect(selected.providers).toContainEqual({ name: 'google_places', configured: false, enabled: false });

    const insecure = registry({
      nodeEnv: 'development',
      'sourceProvider.provider': 'osm',
      'sourceProvider.overpassApiUrl': 'http://overpass.example/api',
    }).status();
    expect(insecure.providers).toContainEqual({ name: 'osm', configured: false, enabled: false });
  });
});
