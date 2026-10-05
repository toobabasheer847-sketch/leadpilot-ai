import type { SourceProvider } from '../types/source.types';

/** Known SOURCE_PROVIDER values that map to real providers. */
const SUPPORTED_PROVIDERS = new Set(['google_places', 'osm', 'openrouter', 'fake', 'fake_source']);

/**
 * Strict provider selector — throws on any unsupported or misconfigured value.
 * Used in unit tests and internally by the resolver below.
 */
export function selectDiscoveryProvider(
  nodeEnv: string,
  providerName: string,
  google: SourceProvider,
  osm: SourceProvider,
  fake: SourceProvider,
  openRouter?: SourceProvider,
): SourceProvider {
  const selected = providerName || 'google_places';
  if (selected === 'fake' || selected === 'fake_source') {
    if (nodeEnv === 'production') throw new Error('SOURCE_PROVIDER=fake is not allowed in production');
    return fake;
  }
  if (selected === 'google_places') return google;
  if (selected === 'osm') return osm;
  if (selected === 'openrouter' && openRouter) return openRouter;
  if (selected === 'openrouter') throw new Error('SOURCE_PROVIDER=openrouter is not available');
  throw new Error(`Unsupported SOURCE_PROVIDER: ${selected}`);
}

/**
 * Graceful provider resolver for use at application bootstrap (e.g. NestJS module factory).
 *
 * If SOURCE_PROVIDER is set to an unsupported value (e.g. "serpapi") or if the provider
 * would otherwise throw, this function:
 *   1. Logs a warning to stderr.
 *   2. Falls back to Tavily-backed web search by checking tavilyApiKey.
 *   3. Falls back further to "osm" when no Tavily key is available.
 *
 * The strict `selectDiscoveryProvider` is preserved unchanged for test-time assertions.
 */
export function resolveDiscoveryProvider(
  nodeEnv: string,
  providerName: string,
  google: SourceProvider,
  osm: SourceProvider,
  fake: SourceProvider,
  tavilyApiKey?: string,
  openRouter?: SourceProvider,
): SourceProvider {
  // Normalise: blank/missing value defaults to google_places (same as selectDiscoveryProvider).
  const configured = (providerName || '').trim() || 'google_places';

  // Fast-path: value is a known provider — delegate to strict selector (may still throw for fake-in-prod).
  if (SUPPORTED_PROVIDERS.has(configured)) {
    return selectDiscoveryProvider(nodeEnv, configured, google, osm, fake, openRouter);
  }

  // Unknown provider name — build a helpful warning then fall back gracefully.
  const fallbackTarget = tavilyApiKey?.trim() ? 'tavily (web-search stage)' : 'osm';
  // eslint-disable-next-line no-console
  console.warn(
    `[LeadPilot] WARNING: SOURCE_PROVIDER="${configured}" is not a supported map-provider value. ` +
    `Falling back to ${fallbackTarget}. ` +
    `Supported values: google_places, osm, openrouter${nodeEnv !== 'production' ? ', fake' : ''}.`,
  );

  // Tavily is a web-search provider, not a map provider — the map stage defaults to osm.
  // The caller is responsible for wiring Tavily in the web-search refill stage.
  return osm;
}

/**
 * Phase Q — ordered map-provider chain for one discovery execution.
 * Selected SOURCE_PROVIDER runs first; other configured map providers follow
 * (Google Places before OpenStreetMap when both are fallbacks). Fake stays alone.
 * Web search remains a separate refill stage after map providers.
 */
export function discoveryMapProviderChain(
  nodeEnv: string,
  providerName: string,
  google: SourceProvider,
  osm: SourceProvider,
  fake: SourceProvider,
  tavilyApiKey?: string,
  openRouter?: SourceProvider,
): SourceProvider[] {
  const selected = providerName || 'google_places';
  const primary = resolveDiscoveryProvider(nodeEnv, selected, google, osm, fake, tavilyApiKey, openRouter);
  if (primary.metadata().synthetic) return [primary];
  if (selected === 'openrouter') return [primary];

  const chain: SourceProvider[] = [primary];
  const pushIfConfigured = (provider: SourceProvider) => {
    if (chain.some((entry) => entry.providerName() === provider.providerName())) return;
    if (!provider.health().configured) return;
    chain.push(provider);
  };

  // Preferred fallback order among additional map providers: Google Places, then OSM.
  if (selected === 'osm') {
    pushIfConfigured(google);
  } else if (selected === 'google_places') {
    pushIfConfigured(osm);
  } else {
    pushIfConfigured(google);
    pushIfConfigured(osm);
  }
  return chain;
}
