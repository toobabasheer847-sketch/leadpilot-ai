import type { SourceProvider } from '../types/source.types';

export const SOURCE_PROVIDER = 'SOURCE_PROVIDER';

/** Ordered map-provider chain for Phase Q resilient discovery (execution-scoped usage). */
export const DISCOVERY_PROVIDER_CHAIN = 'DISCOVERY_PROVIDER_CHAIN';

export type SourceProviderToken = SourceProvider;
export type DiscoveryProviderChainToken = SourceProvider[];
