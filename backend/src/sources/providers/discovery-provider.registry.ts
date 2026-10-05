import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DiscoveryProviderRegistry {
  constructor(private readonly config: ConfigService) {}

  status() {
    const nodeEnv = this.config.get<string>('nodeEnv', 'development');
    const selected = this.config.get<string>('sourceProvider.provider', 'google_places');
    const googleConfigured = this.googleConfigured();
    const osmConfigured = this.osmConfigured();
    const openRouterConfigured = this.openRouterConfigured();
    const fakeSelected = selected === 'fake' || selected === 'fake_source';
    const providers = [
      { name: 'google_places', configured: googleConfigured, enabled: selected === 'google_places' && googleConfigured },
      { name: 'osm', configured: osmConfigured, enabled: selected === 'osm' && osmConfigured },
      { name: 'openrouter', configured: openRouterConfigured, enabled: selected === 'openrouter' && openRouterConfigured },
    ];
    if (nodeEnv !== 'production') {
      providers.push({ name: 'fake', configured: true, enabled: fakeSelected });
    }
    return { providers };
  }

  private osmConfigured() {
    const configured = this.config.get<string>('sourceProvider.overpassApiUrl');
    const url = configured?.trim() ? configured : 'https://overpass-api.de/api/interpreter';
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private googleConfigured() {
    const apiKey = this.config.get<string>('sourceProvider.googlePlacesApiKey');
    const baseUrl = this.config.get<string>('sourceProvider.googlePlacesBaseUrl');
    if (!apiKey || !baseUrl) return false;
    try {
      return new URL(baseUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private openRouterConfigured() {
    const apiKey = this.config.get<string>('openRouter.apiKey')?.trim();
    const baseUrl = this.config.get<string>('openRouter.baseUrl')?.trim() || 'https://openrouter.ai/api/v1';
    try {
      return Boolean(apiKey) && new URL(baseUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }
}
