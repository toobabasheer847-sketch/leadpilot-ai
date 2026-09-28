import type { NormalizedSourceResult } from '../types/source.types';

export interface DiscoveryProviderBatch {
  results: NormalizedSourceResult[];
  error: string | null;
}

/** Companies already saved, or accepted from a provider, stay. A temporary provider error does not erase them. */
export function resolveDiscoveryFallback(input: {
  primary: DiscoveryProviderBatch;
  web: DiscoveryProviderBatch | null;
}): { primary: NormalizedSourceResult[]; web: NormalizedSourceResult[]; duplicatesRemoved: number } {
  const { accepted, duplicatesRemoved } = dedupeDiscoveryCandidates(input.primary.results, input.web?.results ?? []);
  return { primary: input.primary.results, web: accepted, duplicatesRemoved };
}

/**
 * Zero saved companies is a provider failure only when every available discovery provider failed.
 * A temporary OSM error with a successful (even empty) web response is a shortfall, not a hard fail.
 */
export function discoveryProviderFailure(
  saved: number,
  primaryProvider: string,
  primaryError: string | null,
  web: { error: string | null } | null,
): string | null {
  if (saved > 0) return null;
  const primaryFailed = Boolean(primaryError);
  const webUnavailable = web === null;
  const webFailed = Boolean(web?.error);
  if (!primaryFailed && !webFailed) return null;
  if (!(primaryFailed && (webUnavailable || webFailed))) return null;
  const label = primaryProvider === 'osm' ? 'OpenStreetMap' : primaryProvider;
  const details = [
    primaryError ? `${label}: ${primaryError}` : '',
    webFailed ? `Web search: ${web?.error}` : '',
  ].filter(Boolean);
  return `Discovery providers failed. ${details.join(' ')}`;
}

export function dedupeDiscoveryCandidates(
  existing: NormalizedSourceResult[],
  incoming: NormalizedSourceResult[],
): { accepted: NormalizedSourceResult[]; duplicatesRemoved: number } {
  const seen = new Set<string>();
  for (const result of existing) discoveryIdentityKeys(result).forEach((key) => seen.add(key));
  const accepted: NormalizedSourceResult[] = [];
  let duplicatesRemoved = 0;
  for (const result of incoming) {
    const keys = discoveryIdentityKeys(result);
    if (keys.some((key) => seen.has(key))) {
      duplicatesRemoved += 1;
      continue;
    }
    keys.forEach((key) => seen.add(key));
    accepted.push(result);
  }
  return { accepted, duplicatesRemoved };
}

export function discoveryIdentityKeys(result: Pick<NormalizedSourceResult, 'externalId' | 'name' | 'website' | 'address'>): string[] {
  const keys: string[] = [];
  if (result.externalId) keys.push(`id:${result.externalId}`);
  const website = websiteKey(result.website);
  if (website) keys.push(`website:${website}`);
  const name = result.name?.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const city = result.address?.city?.trim().toLowerCase();
  const state = result.address?.state?.trim().toLowerCase();
  if (name && city) keys.push(`place:${name}|${city}|${state ?? ''}`);
  return keys;
}

function websiteKey(website?: string): string | null {
  if (!website?.trim()) return null;
  try {
    const url = new URL(website);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return website.trim().toLowerCase();
  }
}
