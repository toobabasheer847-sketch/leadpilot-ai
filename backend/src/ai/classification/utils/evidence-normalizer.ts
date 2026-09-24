import type { NormalizedEvidence } from '../types/classification.types';

export function normalizeEvidence(rows: Array<{
  id: string;
  evidenceType: string;
  sourceUrl: string;
  evidenceText: string;
  evidenceTimestamp: Date | null;
  metadata: unknown;
}>): NormalizedEvidence[] {
  return rows
    .filter((row) => row.evidenceText.trim().length > 0 && row.sourceUrl.trim().length > 0)
    .map((row) => {
      const metadata = typeof row.metadata === 'object' && row.metadata !== null ? row.metadata as Record<string, unknown> : {};
      return {
        evidenceId: row.id,
        sourceType: row.evidenceType,
        sourceUrl: row.sourceUrl,
        title: typeof metadata.title === 'string' ? metadata.title : null,
        excerpt: row.evidenceText.trim().slice(0, 4000),
        retrievedAt: (row.evidenceTimestamp ?? new Date()).toISOString(),
      };
    });
}
