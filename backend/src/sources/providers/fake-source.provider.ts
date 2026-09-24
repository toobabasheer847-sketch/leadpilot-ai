import { SearchPlan } from '../../search/types/search-plan.types';
import { SourceProvider, SourceSearchContext, SourceSearchResult } from '../types/source.types';

export class FakeSourceProvider implements SourceProvider {
  readonly name = 'fake_source';

  getSourceType() { return this.name; }
  getProviderName() { return this.name; }

  async search(_plan: SearchPlan, _context: SourceSearchContext): Promise<SourceSearchResult> {
    return {
      provider: this.name,
      results: [{
        externalId: 'test-place-001',
        name: 'Synthetic Example Business',
        website: 'https://example.test',
        sourceUrl: 'https://example.test/source/test-place-001',
        category: 'Synthetic test business',
        address: { city: 'Austin', state: 'Texas', postalCode: '78701', country: 'US' },
        rawData: { synthetic: true },
      }],
    };
  }
}
