import { SearchPlan } from '../../search/types/search-plan.types';

export interface SourceAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

export interface NormalizedSourceResult {
  externalId: string;
  name: string;
  website?: string;
  phone?: string;
  address?: SourceAddress;
  category?: string;
  sourceUrl: string;
  rawData?: Record<string, unknown>;
}

export interface SourceSearchResult {
  provider: string;
  results: NormalizedSourceResult[];
}

export interface SourceSearchContext {
  organizationId: string;
  searchExecutionId: string;
  signal?: AbortSignal;
}

export interface SourceProvider {
  readonly name: string;
  search(plan: SearchPlan, context: SourceSearchContext): Promise<SourceSearchResult>;
}
