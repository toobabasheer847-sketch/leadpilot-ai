import {
  DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES,
  type DiscoveryProviderOutcome,
} from './discovery-provider-outcome';

/**
 * Phase Q — execution-scoped provider circuit breaker.
 * State must never leak across organizations, users, or executions.
 */
export class DiscoveryExecutionCircuit {
  private readonly unavailable = new Map<string, { outcome: DiscoveryProviderOutcome; message: string | null }>();

  constructor(private readonly executionId: string, private readonly organizationId: string) {}

  scope() {
    return { executionId: this.executionId, organizationId: this.organizationId };
  }

  isUnavailable(provider: string): boolean {
    return this.unavailable.has(provider);
  }

  reason(provider: string): { outcome: DiscoveryProviderOutcome; message: string | null } | null {
    return this.unavailable.get(provider) ?? null;
  }

  /** Open the circuit for this provider for the rest of the execution. */
  trip(provider: string, outcome: DiscoveryProviderOutcome, message: string | null): boolean {
    if (!DISCOVERY_PROVIDER_CIRCUIT_OUTCOMES.has(outcome)) return false;
    if (this.unavailable.has(provider)) return false;
    this.unavailable.set(provider, { outcome, message });
    return true;
  }

  unavailableProviders(): string[] {
    return [...this.unavailable.keys()];
  }
}
