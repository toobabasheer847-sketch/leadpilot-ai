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
  email?: string;
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
  requestId?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface ProviderHealth {
  name: string;
  configured: boolean;
  enabled: boolean;
}

export interface ProviderMetadata {
  provider: string;
  sourceType: string;
  synthetic: boolean;
}

export interface DiscoveryProvider {
  providerName(): string;
  searchBusinesses(plan: SearchPlan, context: SourceSearchContext): Promise<SourceSearchResult>;
  normalizeResult(raw: unknown): NormalizedSourceResult;
  health(): ProviderHealth;
  metadata(): ProviderMetadata;
}

export interface SourceProvider extends DiscoveryProvider {
  readonly name: string;
  getProviderName(): string;
  getSourceType(): string;
  search(plan: SearchPlan, context: SourceSearchContext): Promise<SourceSearchResult>;
}
