import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WEB_SEARCH_PROVIDER, type WebSearchProvider } from '../../../enrichment/website/web-search.types';
import type { SearchPlan } from '../../../search/types/search-plan.types';
import type { NormalizedSourceResult } from '../../types/source.types';
import {
  collectWebCompanyCandidates,
  queryBudgetForPlan,
  type CollectWebCompanyOptions,
  type WebCompanyCollection,
} from './company-discovery.assess';

@Injectable()
export class WebSearchCompanyDiscovery {
  constructor(
    @Inject(WEB_SEARCH_PROVIDER) private readonly search: WebSearchProvider,
    private readonly config: ConfigService,
  ) {}

  collect(
    plan: SearchPlan,
    remaining: number,
    exclude: NormalizedSourceResult[] = [],
    round = 0,
    stream?: Pick<CollectWebCompanyOptions, 'onBatch'>,
  ): Promise<WebCompanyCollection> {
    if (typeof this.search.searchText !== 'function') {
      return Promise.resolve({
        results: [],
        rejected: 0,
        providerError: 'Web company discovery is not configured.',
        queriesRun: 0,
      });
    }
    const searchText = this.search.searchText.bind(this.search);
    const delayMs = Math.max(0, this.config.get<number>('sourceProvider.retryDelayMs') ?? 0);
    const concurrency = Math.max(1, this.config.get<number>('sourceProvider.discoveryQueryConcurrency')
      ?? this.config.get<number>('sourceProvider.concurrency')
      ?? 1);
    const queryTimeoutMs = Math.max(1, this.config.get<number>('sourceProvider.discoveryQueryTimeoutMs')
      ?? this.config.get<number>('webSearch.timeoutMs')
      ?? 1);
    const persistChunkSize = Math.max(1, this.config.get<number>('sourceProvider.discoveryPersistChunkSize')
      ?? this.config.get<number>('sourceProvider.pageSize')
      ?? 1);
    const maxConsecutiveFailures = Math.max(1, this.config.get<number>('sourceProvider.discoveryMaxConsecutiveFailures') ?? 1);
    const maxResults = Math.max(1, this.config.get<number>('webSearch.maxResults') ?? 1);

    return collectWebCompanyCandidates(
      plan,
      remaining,
      (query, options) => searchText(query, { maxResults, signal: options?.signal }),
      {
        maxQueries: queryBudgetForPlan(plan, remaining),
        delayMs,
        concurrency,
        queryTimeoutMs,
        persistChunkSize,
        maxConsecutiveFailures,
        exclude,
        round,
        onBatch: stream?.onBatch,
      },
    );
  }
}
