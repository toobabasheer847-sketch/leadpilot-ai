import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../../../enrichment/website/web-search.types';
import type { SearchPlan } from '../../../search/types/search-plan.types';
import type { NormalizedSourceResult } from '../../types/source.types';
import { collectWebCompanyCandidates, queryBudgetForPlan, type WebCompanyCollection } from './company-discovery.assess';

@Injectable()
export class WebSearchCompanyDiscovery {
  constructor(
    @Inject(WEB_SEARCH_PROVIDER) private readonly search: WebSearchProvider,
    private readonly config: ConfigService,
  ) {}

  collect(plan: SearchPlan, remaining: number, exclude: NormalizedSourceResult[] = [], round = 0): Promise<WebCompanyCollection> {
    if (typeof this.search.searchText !== 'function') {
      return Promise.resolve({
        results: [],
        rejected: 0,
        providerError: 'Web company discovery is not configured.',
        queriesRun: 0,
      });
    }
    const searchText = this.search.searchText.bind(this.search);
    const delayMs = Math.min(2000, Math.max(0, this.config.get<number>('sourceProvider.retryDelayMs') ?? 250));
    return collectWebCompanyCandidates(plan, remaining, (query) => searchText(query, { maxResults: 20 }), {
      maxQueries: queryBudgetForPlan(plan, remaining),
      delayMs,
      exclude,
      round,
    });
  }
}
