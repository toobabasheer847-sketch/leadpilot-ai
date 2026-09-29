import type { NormalizedSourceResult } from '../types/source.types';
import {
  aggregateDiscoveryFailure,
  classifyDiscoveryProviderOutcome,
  type DiscoveryProviderAttempt,
} from './discovery-provider-outcome';

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
 * EMPTY / successful empty responses are shortfalls, not hard fails.
 * Prefer {@link aggregateDiscoveryFailure} with full attempt records when available.
 */
export function discoveryProviderFailure(
  saved: number,
  primaryProvider: string,
  primaryError: string | null,
  web: { error: string | null } | null,
): string | null {
  return aggregateDiscoveryFailure(saved, attemptsFromLegacy(primaryProvider, primaryError, web));
}

export function attemptsFromLegacy(
  primaryProvider: string,
  primaryError: string | null,
  web: { error: string | null } | null,
): DiscoveryProviderAttempt[] {
  const attempts: DiscoveryProviderAttempt[] = [
    {
      provider: primaryProvider,
      outcome: classifyDiscoveryProviderOutcome({ resultsCount: 0, error: primaryError }),
      message: primaryError,
      resultsCount: 0,
      queriesRun: 0,
      queriesSkipped: 0,
    },
  ];
  if (web === null) return attempts;
  attempts.push({
    provider: 'web_search',
    outcome: classifyDiscoveryProviderOutcome({ resultsCount: 0, error: web.error }),
    message: web.error,
    resultsCount: 0,
    queriesRun: 0,
    queriesSkipped: 0,
  });
  return attempts;
}

export function dedupeDiscoveryCandidates(
  existing: NormalizedSourceResult[],
  incoming: NormalizedSourceResult[],
): {
  accepted: NormalizedSourceResult[];
  duplicatesRemoved: number;
  /** Phase R — duplicates kept for empty-field enrichment; not counted as new candidates. */
  supplements: NormalizedSourceResult[];
} {
  const seen = new Set<string>();
  for (const result of existing) discoveryIdentityKeys(result).forEach((key) => seen.add(key));
  const accepted: NormalizedSourceResult[] = [];
  const supplements: NormalizedSourceResult[] = [];
  let duplicatesRemoved = 0;
  for (const result of incoming) {
    const keys = discoveryIdentityKeys(result);
    if (keys.some((key) => seen.has(key))) {
      duplicatesRemoved += 1;
      supplements.push(result);
      continue;
    }
    keys.forEach((key) => seen.add(key));
    accepted.push(result);
  }
  return { accepted, duplicatesRemoved, supplements };
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
