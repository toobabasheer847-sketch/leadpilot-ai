/**
 * Phase Q — provider attempt outcomes for resilient discovery.
 * EMPTY is not FAILURE: a provider may succeed with zero matching companies.
 */

export const DISCOVERY_PROVIDER_OUTCOMES = [
  'SUCCESS',
  'EMPTY',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'CONFIGURATION_ERROR',
  'LOCATION_RESOLUTION_FAILED',
  'TEMPORARY_ERROR',
  'FATAL_ERROR',
] as const;

export type DiscoveryProviderOutcome = (typeof DISCOVERY_PROVIDER_OUTCOMES)[number];

/** Outcomes that mean the provider did not complete usable discovery work. */
export const DISCOVERY_PROVIDER_FAILURE_OUTCOMES = new Set<DiscoveryProviderOutcome>([
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'CONFIGURATION_ERROR',
  'LOCATION_RESOLUTION_FAILED',
  'TEMPORARY_ERROR',
  'FATAL_ERROR',
]);

/** Outcomes that open the execution-scoped circuit breaker (stop further calls to that provider). */
export const DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES = new Set<DiscoveryProviderOutcome>([
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'CONFIGURATION_ERROR',
  'LOCATION_RESOLUTION_FAILED',
  'FATAL_ERROR',
]);

export interface DiscoveryProviderAttempt {
  provider: string;
  outcome: DiscoveryProviderOutcome;
  message: string | null;
  resultsCount: number;
  queriesRun: number;
  queriesSkipped: number;
}

export function providerDisplayName(provider: string): string {
  if (provider === 'osm') return 'OpenStreetMap';
  if (provider === 'google_places') return 'Google Places';
  if (provider === 'web_search') return 'Web Search';
  if (provider === 'fake' || provider === 'fake_source') return 'Fake';
  return provider;
}

export function classifyDiscoveryProviderOutcome(input: {
  resultsCount: number;
  error?: string | null;
  errorCode?: string | null;
}): DiscoveryProviderOutcome {
  const error = input.error?.trim() || null;
  if (!error) return input.resultsCount > 0 ? 'SUCCESS' : 'EMPTY';

  const code = input.errorCode?.trim() || '';
  const text = error;

  if (
    code === 'PROVIDER_QUOTA_EXCEEDED'
    || /plan limit|pay-as-you-go limit|quota|HTTP 432|HTTP 433|RESOURCE_EXHAUSTED/i.test(text)
  ) {
    return 'QUOTA_EXCEEDED';
  }
  if (code === 'PROVIDER_RATE_LIMITED' || /rate limit|429/i.test(text)) {
    return 'RATE_LIMITED';
  }
  if (code === 'PROVIDER_AUTH_ERROR' || /authentication failed|auth(?:entication)?/i.test(text)) {
    return 'AUTH_FAILED';
  }
  if (
    code === 'PROVIDER_NOT_CONFIGURED'
    || /not configured|missing api key|configuration/i.test(text)
  ) {
    return 'CONFIGURATION_ERROR';
  }
  if (
    /could not resolve the search location|could not resolve.*(location|place)|location resolution/i.test(text)
  ) {
    return 'LOCATION_RESOLUTION_FAILED';
  }
  if (
    code === 'PROVIDER_TIMEOUT'
    || code === 'PROVIDER_UNAVAILABLE'
    || /timed out|timeout|temporarily unavailable|unavailable/i.test(text)
  ) {
    return 'TEMPORARY_ERROR';
  }
  if (code === 'PROVIDER_INVALID_REQUEST') {
    // Invalid requests that are not location-resolution still block this provider for the execution.
    return 'FATAL_ERROR';
  }
  return 'FATAL_ERROR';
}

export function outcomeLabel(outcome: DiscoveryProviderOutcome): string {
  switch (outcome) {
    case 'SUCCESS':
      return 'COMPLETED';
    case 'EMPTY':
      return 'EMPTY';
    case 'QUOTA_EXCEEDED':
      return 'QUOTA EXCEEDED';
    case 'RATE_LIMITED':
      return 'RATE LIMITED';
    case 'AUTH_FAILED':
      return 'AUTH FAILED';
    case 'CONFIGURATION_ERROR':
      return 'CONFIGURATION ERROR';
    case 'LOCATION_RESOLUTION_FAILED':
      return 'LOCATION RESOLUTION FAILED';
    case 'TEMPORARY_ERROR':
      return 'TEMPORARY ERROR';
    case 'FATAL_ERROR':
      return 'FAILED';
    default:
      return outcome;
  }
}

export function briefOutcomeReason(attempt: DiscoveryProviderAttempt): string {
  switch (attempt.outcome) {
    case 'SUCCESS':
      return 'completed';
    case 'EMPTY':
      return 'empty';
    case 'QUOTA_EXCEEDED':
      return 'quota exceeded';
    case 'RATE_LIMITED':
      return 'rate limited';
    case 'AUTH_FAILED':
      return 'authentication failed';
    case 'CONFIGURATION_ERROR':
      return 'configuration error';
    case 'LOCATION_RESOLUTION_FAILED':
      return 'location resolution failed';
    case 'TEMPORARY_ERROR':
      return attempt.message?.trim() || 'temporary error';
    case 'FATAL_ERROR':
      return attempt.message?.trim() || 'failed';
    default:
      return attempt.outcome;
  }
}

/** Hard-fail only when zero candidates were saved and every attempted provider failed (not EMPTY/SUCCESS). */
export function aggregateDiscoveryFailure(saved: number, attempts: DiscoveryProviderAttempt[]): string | null {
  if (saved > 0) return null;
  if (!attempts.length) return null;

  const usable = attempts.filter((attempt) => attempt.outcome === 'SUCCESS' || attempt.outcome === 'EMPTY');
  if (usable.length > 0) return null;

  const failed = attempts.filter((attempt) => DISCOVERY_PROVIDER_FAILURE_OUTCOMES.has(attempt.outcome));
  if (!failed.length) return null;

  const lines = failed.map((attempt) => `${providerDisplayName(attempt.provider)}: ${briefOutcomeReason(attempt)}`);
  return `Discovery failed because all configured providers were unavailable:\n${lines.join('\n')}`;
}

/** Honest shortfall summary when discovery finished with candidates and provider limitations. */
export function discoveryCompletedWithLimitationsMessage(
  saved: number,
  requested: number | null,
  attempts: DiscoveryProviderAttempt[],
): string | null {
  const limited = attempts.filter((attempt) => DISCOVERY_PROVIDER_FAILURE_OUTCOMES.has(attempt.outcome));
  if (!limited.length) return null;
  const lines = attempts.map((attempt) => `${providerDisplayName(attempt.provider)}: ${briefOutcomeReason(attempt)}`);
  const found = requested == null
    ? `Found ${saved} companies.`
    : `Found ${saved} of ${requested} requested companies.`;
  return `Discovery completed with provider limitations:\n${lines.join('\n')}\n${found}`;
}

export function discoveryProgressSummary(attempts: DiscoveryProviderAttempt[]): {
  providersAttempted: number;
  providersSucceeded: number;
  providersEmpty: number;
  providersUnavailable: number;
  providersQuotaExceeded: number;
  providersFailed: number;
  queriesAttempted: number;
  queriesSkipped: number;
  providerStatusLines: string[];
  providerStatusSummary: string;
} {
  const providersAttempted = attempts.length;
  const providersSucceeded = attempts.filter((a) => a.outcome === 'SUCCESS').length;
  const providersEmpty = attempts.filter((a) => a.outcome === 'EMPTY').length;
  const providersQuotaExceeded = attempts.filter((a) => a.outcome === 'QUOTA_EXCEEDED').length;
  const providersUnavailable = attempts.filter((a) => (
    a.outcome === 'CONFIGURATION_ERROR'
    || a.outcome === 'AUTH_FAILED'
    || a.outcome === 'LOCATION_RESOLUTION_FAILED'
    || a.outcome === 'QUOTA_EXCEEDED'
    || a.outcome === 'RATE_LIMITED'
  )).length;
  const providersFailed = attempts.filter((a) => DISCOVERY_PROVIDER_FAILURE_OUTCOMES.has(a.outcome)).length;
  const queriesAttempted = attempts.reduce((sum, a) => sum + a.queriesRun, 0);
  const queriesSkipped = attempts.reduce((sum, a) => sum + a.queriesSkipped, 0);
  const providerStatusLines = attempts.map((a) => `${providerDisplayName(a.provider)} — ${outcomeLabel(a.outcome)}`);
  return {
    providersAttempted,
    providersSucceeded,
    providersEmpty,
    providersUnavailable,
    providersQuotaExceeded,
    providersFailed,
    queriesAttempted,
    queriesSkipped,
    providerStatusLines,
    providerStatusSummary: providerStatusLines.join(' | '),
  };
}

export function discoveryFailureCodeFromAttempts(
  attempts: DiscoveryProviderAttempt[],
): 'PROVIDER_RATE_LIMITED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_QUOTA_EXCEEDED' | 'PROVIDER_UNAVAILABLE' {
  if (attempts.some((a) => a.outcome === 'QUOTA_EXCEEDED')) return 'PROVIDER_QUOTA_EXCEEDED';
  if (attempts.some((a) => a.outcome === 'RATE_LIMITED')) return 'PROVIDER_RATE_LIMITED';
  if (attempts.some((a) => a.outcome === 'TEMPORARY_ERROR' && /timed out|timeout/i.test(a.message ?? ''))) {
    return 'PROVIDER_TIMEOUT';
  }
  return 'PROVIDER_UNAVAILABLE';
}
