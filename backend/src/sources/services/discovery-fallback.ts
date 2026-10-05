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
  const seen = [...existing];
  const accepted: NormalizedSourceResult[] = [];
  const supplements: NormalizedSourceResult[] = [];
  let duplicatesRemoved = 0;
  for (const result of incoming) {
    if (seen.some((candidate) => areDiscoveryCandidatesDuplicates(candidate, result))) {
      duplicatesRemoved += 1;
      supplements.push(result);
      continue;
    }
    seen.push(result);
    accepted.push(result);
  }
  return { accepted, duplicatesRemoved, supplements };
}

export function areDiscoveryCandidatesDuplicates(
  left: Pick<NormalizedSourceResult, 'externalId' | 'name' | 'website' | 'address' | 'rawData'>,
  right: Pick<NormalizedSourceResult, 'externalId' | 'name' | 'website' | 'address' | 'rawData'>,
): boolean {
  if (isOpenRouterCandidate(left) && isOpenRouterCandidate(right) && sameWebsiteHost(left.website, right.website)) {
    const leftPeople = decisionMakerNames(left);
    const rightPeople = decisionMakerNames(right);
    if ((leftPeople.length || rightPeople.length)
      && (leftPeople.length !== rightPeople.length || leftPeople.some((name) => !rightPeople.includes(name)))) return false;
    const leftLocation = locationKey(left);
    const rightLocation = locationKey(right);
    if ((leftLocation || rightLocation) && leftLocation !== rightLocation) return false;
  }
  const leftKeys = discoveryIdentityKeys(left);
  const rightKeys = new Set(discoveryIdentityKeys(right));
  return leftKeys.some((key) => rightKeys.has(key));
}

export function discoveryIdentityKeys(
  result: Pick<NormalizedSourceResult, 'externalId' | 'name' | 'website' | 'address' | 'rawData'>,
): string[] {
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

function isOpenRouterCandidate(result: Pick<NormalizedSourceResult, 'rawData'>): boolean {
  return result.rawData?.source === 'openrouter'
    || result.rawData?.provider === 'openrouter'
    || result.rawData?.qualificationStatus === 'PENDING';
}

function decisionMakerNames(result: Pick<NormalizedSourceResult, 'rawData'>): string[] {
  const raw = result.rawData ?? {};
  const fields = raw.openRouterFields && typeof raw.openRouterFields === 'object'
    ? raw.openRouterFields as Record<string, unknown>
    : {};
  const names = [
    ...(typeof fields.personName === 'string' ? [fields.personName] : []),
    ...(Array.isArray(raw.openRouterContacts)
      ? raw.openRouterContacts.flatMap((contact) => {
          if (!contact || typeof contact !== 'object') return [];
          const name = (contact as { fullName?: unknown }).fullName;
          return typeof name === 'string' && name.trim() ? [name] : [];
        })
      : []),
  ];
  return [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))].sort();
}

function locationKey(result: Pick<NormalizedSourceResult, 'address'>): string {
  return [
    result.address?.addressLine1,
    result.address?.city,
    result.address?.state,
    result.address?.postalCode,
  ].map((value) => value?.trim().toLowerCase() ?? '').join('|').replace(/\|+$/, '');
}

function sameWebsiteHost(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  try {
    return new URL(left).hostname.toLowerCase().replace(/^www\./, '')
      === new URL(right).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
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
