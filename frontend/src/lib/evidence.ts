import type { EvidenceItem, EvidenceReference } from '../types/api';

export interface EvidenceView {
  sourceType: string | null;
  evidenceType: string | null;
  excerpt: string | null;
  retrievedAt: string | null;
  sourceUrl: string | null;
  relationship: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function metadataOf(item: EvidenceItem): Record<string, unknown> {
  return item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
}

export function evidenceView(item: EvidenceItem): EvidenceView {
  const metadata = metadataOf(item);
  return {
    sourceType: text(item.sourceType) ?? text(metadata.sourceType),
    evidenceType: text(item.evidenceType) ?? text(metadata.evidenceType),
    excerpt: text(item.excerpt) ?? text(item.evidenceText) ?? text(metadata.evidenceExcerpt),
    retrievedAt: text(item.timestamp) ?? text(item.evidenceTimestamp) ?? text(item.retrievedAt) ?? text(metadata.retrievedAt),
    sourceUrl: text(item.sourceUrl),
    relationship: text(metadata.verificationRelationship) ?? text(metadata.relationship),
  };
}

export function mergeEvidence(groups: EvidenceItem[][]): EvidenceItem[] {
  const seen = new Set<string>();
  const result: EvidenceItem[] = [];
  for (const group of groups) {
    for (const item of group) {
      const view = evidenceView(item);
      const key = item.id || `${view.sourceUrl ?? ''}|${view.excerpt ?? ''}|${view.evidenceType ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export function independentSources(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object' || !('independentSources' in metadata)) return null;
  const value = (metadata as { independentSources?: unknown }).independentSources;
  return typeof value === 'number' ? value : null;
}

export function evidenceCountFor(fieldName: string, metadata: unknown, evidence: EvidenceItem[]): number | null {
  const direct = independentSources(metadata);
  if (direct !== null) return direct;
  if (!metadata) return null;
  return evidence.filter((item) => metadataOf(item).field === fieldName).length;
}

export interface CitedEvidence extends EvidenceView {
  reason: string | null;
}

export function citedEvidence(references: EvidenceReference[] | undefined, evidence: EvidenceItem[]): CitedEvidence[] {
  return (references ?? []).map((reference) => {
    const match = reference.evidenceId ? evidence.find((item) => item.id === reference.evidenceId) : undefined;
    const view = match ? evidenceView(match) : { sourceType: null, evidenceType: null, excerpt: null, retrievedAt: null, sourceUrl: null, relationship: null };
    return { ...view, excerpt: view.excerpt ?? text(reference.reason), reason: text(reference.reason) };
  });
}
