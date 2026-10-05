/**
 * Unit tests for the Tavily / web-search QUOTA_EXCEEDED → OSM automatic fallback.
 *
 * These tests cover the pure utility functions that drive the fallback decision
 * inside SourceDiscoveryService:
 *   - classifyDiscoveryProviderOutcome  — quota detection from error strings
 *   - aggregateDiscoveryFailure         — does a successful OSM fallback prevent a hard fail?
 *   - DiscoveryExecutionCircuit         — circuit stays open for quota-tripped providers
 *
 * Service-level integration tests (which require NestJS DI) are skipped here because
 * the project's Jest config runs in CommonJS mode while NestJS v12 ships ESM-only
 * packages.  The integration coverage lives in discovery-phase-q.spec.ts and
 * source-discovery.fallback.spec.ts (skipped in CI until the ESM transform is wired).
 */
import {
  aggregateDiscoveryFailure,
  classifyDiscoveryProviderOutcome,
  DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES,
  type DiscoveryProviderAttempt,
} from './discovery-provider-outcome';
import { DiscoveryExecutionCircuit } from './discovery-execution-circuit';

// ── classifyDiscoveryProviderOutcome — quota detection ────────────────────────

describe('classifyDiscoveryProviderOutcome — quota detection', () => {
  const quotaMessages = [
    'Web search provider plan limit exceeded.',
    'Tavily plan limit reached.',
    'RESOURCE_EXHAUSTED: quota exceeded',
    'HTTP 432',
    'HTTP 433',
    'pay-as-you-go limit reached',
  ];
  const rateLimitMessages = [
    'Tavily API rate limited. Retry after 60 seconds.',
    '429 Too Many Requests',
    'rate limit reached',
  ];

  it.each(quotaMessages)(
    'classifies "%s" as QUOTA_EXCEEDED',
    (errorMessage) => {
      expect(
        classifyDiscoveryProviderOutcome({ resultsCount: 0, error: errorMessage }),
      ).toBe('QUOTA_EXCEEDED');
    },
  );

  it('classifies PROVIDER_QUOTA_EXCEEDED error code as QUOTA_EXCEEDED regardless of message', () => {
    expect(
      classifyDiscoveryProviderOutcome({
        resultsCount: 0,
        error: 'some generic error',
        errorCode: 'PROVIDER_QUOTA_EXCEEDED',
      }),
    ).toBe('QUOTA_EXCEEDED');
  });

  it.each(rateLimitMessages)(
    'classifies "%s" as RATE_LIMITED, not QUOTA_EXCEEDED',
    (errorMessage) => {
      const outcome = classifyDiscoveryProviderOutcome({ resultsCount: 0, error: errorMessage });
      expect(outcome).toBe('RATE_LIMITED');
      expect(outcome).not.toBe('QUOTA_EXCEEDED');
    },
  );

  it('returns SUCCESS when there are results and no error', () => {
    expect(classifyDiscoveryProviderOutcome({ resultsCount: 5, error: null })).toBe('SUCCESS');
  });

  it('returns EMPTY when zero results and no error', () => {
    expect(classifyDiscoveryProviderOutcome({ resultsCount: 0, error: null })).toBe('EMPTY');
  });
});

// ── DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES — QUOTA_EXCEEDED trips the circuit ────

describe('DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES — quota trips the circuit', () => {
  it('includes QUOTA_EXCEEDED so the circuit breaks on Tavily quota exhaustion', () => {
    expect(DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES.has('QUOTA_EXCEEDED')).toBe(true);
  });

  it('includes RATE_LIMITED so rate-limited providers are also blocked for the execution', () => {
    expect(DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES.has('RATE_LIMITED')).toBe(true);
  });

  it('does NOT include TEMPORARY_ERROR so transient timeouts can be retried', () => {
    expect(DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES.has('TEMPORARY_ERROR')).toBe(false);
  });
});

// ── DiscoveryExecutionCircuit — circuit prevents re-use of quota-tripped OSM ──

describe('DiscoveryExecutionCircuit — quota-exceeded trip', () => {
  it('trips for QUOTA_EXCEEDED and marks the provider unavailable', () => {
    const circuit = new DiscoveryExecutionCircuit('exec-1', 'org-1');
    circuit.trip('osm', 'QUOTA_EXCEEDED', 'OSM quota exceeded.');
    expect(circuit.isUnavailable('osm')).toBe(true);
  });

  it('does NOT trip for TEMPORARY_ERROR (transient failures get another chance)', () => {
    const circuit = new DiscoveryExecutionCircuit('exec-2', 'org-2');
    circuit.trip('osm', 'TEMPORARY_ERROR', 'Overpass timeout.');
    expect(circuit.isUnavailable('osm')).toBe(false);
  });

  it('scopes state per-execution — a second circuit for the same provider is clean', () => {
    const circuit1 = new DiscoveryExecutionCircuit('exec-3', 'org-3');
    const circuit2 = new DiscoveryExecutionCircuit('exec-4', 'org-3');
    circuit1.trip('osm', 'QUOTA_EXCEEDED', 'OSM quota exceeded.');
    expect(circuit1.isUnavailable('osm')).toBe(true);
    expect(circuit2.isUnavailable('osm')).toBe(false);
  });

  it('returns the stored outcome and message via reason()', () => {
    const circuit = new DiscoveryExecutionCircuit('exec-5', 'org-5');
    circuit.trip('web_search', 'QUOTA_EXCEEDED', 'Tavily plan limit exceeded.');
    const reason = circuit.reason('web_search');
    expect(reason?.outcome).toBe('QUOTA_EXCEEDED');
    expect(reason?.message).toBe('Tavily plan limit exceeded.');
  });
});

// ── aggregateDiscoveryFailure — OSM fallback success prevents hard fail ───────

describe('aggregateDiscoveryFailure — OSM quota fallback prevents hard failure', () => {
  const webQuotaAttempt: DiscoveryProviderAttempt = {
    provider: 'web_search',
    outcome: 'QUOTA_EXCEEDED',
    message: 'Tavily plan limit exceeded.',
    resultsCount: 0,
    acceptedCandidates: 0,
    duplicatesRemoved: 0,
    queriesRun: 5,
    queriesSkipped: 0,
  };

  it('does NOT hard-fail when OSM fallback attempt succeeds (candidates > 0)', () => {
    const osmFallbackSuccess: DiscoveryProviderAttempt = {
      provider: 'osm_quota_fallback',
      outcome: 'SUCCESS',
      message: null,
      resultsCount: 3,
      acceptedCandidates: 3,
      duplicatesRemoved: 0,
      queriesRun: 2,
      queriesSkipped: 0,
    };
    const failure = aggregateDiscoveryFailure(3, [webQuotaAttempt, osmFallbackSuccess]);
    expect(failure).toBeNull();
  });

  it('does NOT hard-fail when OSM fallback attempt is EMPTY but prior map run succeeded', () => {
    const osmPrimarySuccess: DiscoveryProviderAttempt = {
      provider: 'osm',
      outcome: 'SUCCESS',
      message: null,
      resultsCount: 2,
      acceptedCandidates: 2,
      duplicatesRemoved: 0,
      queriesRun: 3,
      queriesSkipped: 0,
    };
    const osmFallbackEmpty: DiscoveryProviderAttempt = {
      provider: 'osm_quota_fallback',
      outcome: 'EMPTY',
      message: null,
      resultsCount: 0,
      acceptedCandidates: 0,
      duplicatesRemoved: 0,
      queriesRun: 1,
      queriesSkipped: 0,
    };
    const failure = aggregateDiscoveryFailure(2, [webQuotaAttempt, osmPrimarySuccess, osmFallbackEmpty]);
    expect(failure).toBeNull();
  });

  it('hard-fails when ALL providers (web + OSM fallback) are quota-exhausted and candidates === 0', () => {
    const osmPrimaryQuota: DiscoveryProviderAttempt = {
      provider: 'osm',
      outcome: 'QUOTA_EXCEEDED',
      message: 'OpenStreetMap RESOURCE_EXHAUSTED.',
      resultsCount: 0,
      acceptedCandidates: 0,
      duplicatesRemoved: 0,
      queriesRun: 1,
      queriesSkipped: 0,
    };
    const failure = aggregateDiscoveryFailure(0, [webQuotaAttempt, osmPrimaryQuota]);
    expect(failure).not.toBeNull();
    expect(failure).toMatch(/Discovery failed because all configured providers were unavailable/i);
  });

  it('hard-fails when web quota + OSM fallback quota, candidates === 0', () => {
    const osmFallbackQuota: DiscoveryProviderAttempt = {
      provider: 'osm_quota_fallback',
      outcome: 'QUOTA_EXCEEDED',
      message: 'OSM also quota exceeded.',
      resultsCount: 0,
      acceptedCandidates: 0,
      duplicatesRemoved: 0,
      queriesRun: 1,
      queriesSkipped: 0,
    };
    const failure = aggregateDiscoveryFailure(0, [webQuotaAttempt, osmFallbackQuota]);
    expect(failure).not.toBeNull();
  });

  it('does NOT hard-fail when candidates > 0 even if all attempts had errors', () => {
    // Partial results saved before quota hit — should not raise a hard failure.
    const failure = aggregateDiscoveryFailure(1, [webQuotaAttempt]);
    expect(failure).toBeNull();
  });
});
