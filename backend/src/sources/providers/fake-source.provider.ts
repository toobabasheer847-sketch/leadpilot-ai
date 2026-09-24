import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchPlan } from '../../search/types/search-plan.types';
import { NormalizedSourceResult, SourceProvider, SourceSearchContext, SourceSearchResult } from '../types/source.types';
import { SourceProviderError } from './source-provider.error';

const TEST_FIXTURE_ID = 'test-place-001';

@Injectable()
export class FakeSourceProvider implements SourceProvider {
  readonly name = 'fake_source';

  constructor(private readonly config: ConfigService) {}

  providerName() { return 'fake'; }
  getProviderName() { return this.providerName(); }
  getSourceType() { return this.name; }
  metadata() { return { provider: this.providerName(), sourceType: this.name, synthetic: true }; }
  health() {
    const allowed = this.config.get<string>('nodeEnv', 'development') !== 'production';
    return { name: 'fake', configured: allowed, enabled: allowed && this.isSelected() };
  }

  search(plan: SearchPlan, context: SourceSearchContext) {
    return this.searchBusinesses(plan, context);
  }

  async searchBusinesses(_plan: SearchPlan, _context: SourceSearchContext): Promise<SourceSearchResult> {
    if (this.config.get<string>('nodeEnv', 'development') === 'production') {
      throw new SourceProviderError('PROVIDER_NOT_CONFIGURED', 'The test discovery provider is not available.');
    }
    return { provider: this.name, results: [this.normalizeResult({ fixture: true })] };
  }

  normalizeResult(_raw: unknown): NormalizedSourceResult {
    return {
      externalId: TEST_FIXTURE_ID,
      name: 'Synthetic Example Business',
      website: 'https://example.test',
      sourceUrl: 'https://example.test/source/test-place-001',
      category: 'Synthetic test business',
      address: { city: 'Austin', state: 'Texas', postalCode: '78701', country: 'US' },
      rawData: { synthetic: true, fixture: true, evidenceClass: 'TEST_ONLY' },
    };
  }

  private isSelected() {
    const selected = this.config.get<string>('sourceProvider.provider', 'google_places');
    return selected === 'fake' || selected === 'fake_source';
  }
}
