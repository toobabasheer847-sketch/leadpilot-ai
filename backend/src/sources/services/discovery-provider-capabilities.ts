import type { SourceProvider } from '../types/source.types';
import { providerDisplayName } from './discovery-provider-outcome';

/**
 * Phase R — execution-start provider capability inventory.
 * Never includes API keys or secrets.
 */

export type DiscoveryCapabilityStatus =
  | 'AVAILABLE'
  | 'NOT_CONFIGURED';

export interface DiscoveryProviderCapability {
  provider: string;
  displayName: string;
  configured: boolean;
  available: boolean;
  status: DiscoveryCapabilityStatus;
  reason: string | null;
}

export interface DiscoveryCapabilitySnapshot {
  providers: DiscoveryProviderCapability[];
  availableProviders: string[];
  unavailableProviders: string[];
  webSearchAvailable: boolean;
  mapProvidersAvailable: string[];
  summary: string;
}

export function detectDiscoveryProviderCapabilities(input: {
  mapProviders: SourceProvider[];
  webSearchConfigured: boolean;
  includeWebSearch: boolean;
}): DiscoveryCapabilitySnapshot {
  const providers: DiscoveryProviderCapability[] = [];

  for (const provider of input.mapProviders) {
    const name = provider.providerName();
    const configured = Boolean(provider.health?.().configured ?? true);
    providers.push({
      provider: name,
      displayName: providerDisplayName(name),
      configured,
      available: configured,
      status: configured ? 'AVAILABLE' : 'NOT_CONFIGURED',
      reason: configured ? null : `${providerDisplayName(name)} provider is not configured.`,
    });
  }

  if (input.includeWebSearch) {
    providers.push({
      provider: 'web_search',
      displayName: providerDisplayName('web_search'),
      configured: input.webSearchConfigured,
      available: input.webSearchConfigured,
      status: input.webSearchConfigured ? 'AVAILABLE' : 'NOT_CONFIGURED',
      reason: input.webSearchConfigured ? null : 'Web Search provider is not configured.',
    });
  }

  const availableProviders = providers.filter((p) => p.available).map((p) => p.provider);
  const unavailableProviders = providers.filter((p) => !p.available).map((p) => p.provider);
  const mapProvidersAvailable = providers
    .filter((p) => p.available && p.provider !== 'web_search')
    .map((p) => p.provider);
  const webSearchAvailable = providers.some((p) => p.provider === 'web_search' && p.available);

  const summary = providers
    .map((p) => `${p.displayName}: ${p.status === 'AVAILABLE' ? 'AVAILABLE' : 'NOT CONFIGURED'}`)
    .join(' | ');

  return {
    providers,
    availableProviders,
    unavailableProviders,
    webSearchAvailable,
    mapProvidersAvailable,
    summary,
  };
}

/** Ordered usable map providers for this execution (configured only). */
export function usableMapProviders(
  mapProviders: SourceProvider[],
  capabilities: DiscoveryCapabilitySnapshot,
): SourceProvider[] {
  const available = new Set(capabilities.mapProvidersAvailable);
  return mapProviders.filter((provider) => available.has(provider.providerName()));
}
