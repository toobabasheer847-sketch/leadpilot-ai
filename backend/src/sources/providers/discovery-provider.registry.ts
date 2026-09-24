import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DiscoveryProviderRegistry {
  constructor(private readonly config: ConfigService) {}

  status() {
    const nodeEnv = this.config.get<string>('nodeEnv', 'development');
    const selected = this.config.get<string>('sourceProvider.provider', 'google_places');
    const googleConfigured = this.googleConfigured();
    const fakeSelected = selected === 'fake' || selected === 'fake_source';
    const providers = [
      { name: 'google_places', configured: googleConfigured, enabled: selected === 'google_places' && googleConfigured },
    ];
    if (nodeEnv !== 'production') {
      providers.push({ name: 'fake', configured: true, enabled: fakeSelected });
    }
    return { providers };
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
}
