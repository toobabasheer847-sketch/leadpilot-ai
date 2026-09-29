import { clampConcurrency } from './concurrency';

/** Shared worker concurrency for post-discovery enrichment-family queues. */
export function enrichmentWorkerConcurrency(): number {
  return clampConcurrency(
    Number.parseInt(process.env.ENRICHMENT_CONCURRENCY ?? '', 10),
    4,
    16,
  );
}
