import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FieldClaim, VerificationConflictLog, VerificationEvidence, VerificationInput, VerificationSignal } from '../types/verification.types';
import { independentSourceKey } from '../utils/email-ownership';

@Injectable()
export class ConflictEngineService {
  evaluateField(input: VerificationInput, sourcePriority: (item: VerificationEvidence) => number): VerificationSignal {
    if (!input.value) {
      return { status: 'NOT_FOUND', verificationType: 'SOURCE_EVIDENCE', provider: 'stored-evidence' };
    }

    const claims = this.collectClaims(input.field, input.evidence);
    const byValue = new Map<string, FieldClaim[]>();
    for (const claim of claims) {
      const key = this.normalize(input.field, claim.value);
      const group = byValue.get(key) ?? [];
      group.push(claim);
      byValue.set(key, group);
    }

    if (byValue.size > 1) {
      const [first, second] = [...byValue.values()].map((group) => group[0]);
      const conflict = this.buildConflict(input.field, first, second);
      return {
        status: 'NEEDS_REVIEW',
        verificationType: 'CROSS_SOURCE_MATCH',
        provider: 'stored-evidence',
        conflict,
        metadata: {
          evidenceIds: claims.map((claim) => claim.evidenceId).filter(Boolean),
          values: [...byValue.keys()],
          sourceCount: this.independentSourceCount(claims),
          ownershipVerified: false,
          verificationKind: 'evidence',
          requiresReview: true,
          conflict,
        },
      };
    }

    const matches = claims.filter((claim) => this.normalize(input.field, claim.value) === this.normalize(input.field, input.value!));
    if (!matches.length) {
      const textMatches = input.evidence.filter((item) => this.evidenceMatches(item, input.field, input.value!));
      if (!textMatches.length) {
        return {
          status: 'UNVERIFIED',
          verificationType: 'SOURCE_EVIDENCE',
          provider: 'stored-evidence',
          metadata: { ownershipVerified: false, verificationKind: 'syntax', sourceCount: 0 },
        };
      }
      const distinct = new Set(textMatches.map((item) => this.evidenceValue(item)).filter(Boolean).map((value) => this.normalize(input.field, value!)));
      if (distinct.size > 1) {
        const [first, second] = textMatches;
        const conflict = this.buildConflict(
          input.field,
          this.toClaim(first, this.evidenceValue(first) ?? input.value!),
          this.toClaim(second, this.evidenceValue(second) ?? input.value!),
        );
        return {
          status: 'NEEDS_REVIEW',
          verificationType: 'CROSS_SOURCE_MATCH',
          provider: 'stored-evidence',
          conflict,
          metadata: { evidenceIds: textMatches.map((item) => item.id), requiresReview: true, ownershipVerified: false, conflict },
        };
      }
      const lead = textMatches[0];
      const sourceCount = this.independentSourceCount(textMatches.map((item) => this.toClaim(item, input.value!)));
      return {
        status: sourceCount >= 2 ? 'VERIFIED' : 'SUPPORTED',
        verificationType: 'SOURCE_EVIDENCE',
        provider: 'stored-evidence',
        evidenceId: lead.id,
        confidence: sourceCount >= 2 ? 0.9 : 0.75,
        provenance: {
          sourceType: lead.sourceType ?? lead.provider ?? null,
          sourceUrl: lead.canonicalUrl ?? lead.sourceUrl,
          retrievedAt: lead.retrievedAt,
          evidenceExcerpt: lead.evidenceText,
        },
        metadata: {
          sourceCount,
          sourcePriority: sourcePriority(lead),
          ownershipVerified: false,
          verificationKind: sourceCount >= 2 ? 'independent_evidence' : 'evidence_supported',
        },
      };
    }

    const sourceCount = this.independentSourceCount(matches);
    const lead = matches[0];
    return {
      status: sourceCount >= 2 ? 'VERIFIED' : 'SUPPORTED',
      verificationType: 'SOURCE_EVIDENCE',
      provider: 'stored-evidence',
      evidenceId: lead.evidenceId,
      confidence: sourceCount >= 2 ? 0.9 : 0.75,
      provenance: {
        sourceType: lead.sourceType,
        sourceUrl: lead.sourceUrl,
        retrievedAt: lead.retrievedAt,
        evidenceExcerpt: lead.evidenceExcerpt,
      },
      metadata: {
        sourceCount,
        sourcePriority: sourcePriority({ provider: lead.provider, sourceType: lead.sourceType } as VerificationEvidence),
        ownershipVerified: false,
        verificationKind: sourceCount >= 2 ? 'independent_evidence' : 'evidence_supported',
      },
    };
  }

  buildConflict(fieldName: string, claimA: FieldClaim, claimB: FieldClaim): VerificationConflictLog {
    return {
      fieldName,
      valueA: claimA.value,
      valueB: claimB.value,
      sourceTypeA: claimA.sourceType,
      sourceUrlA: claimA.sourceUrl,
      retrievedAtA: claimA.retrievedAt,
      evidenceExcerptA: claimA.evidenceExcerpt,
      sourceTypeB: claimB.sourceType,
      sourceUrlB: claimB.sourceUrl,
      retrievedAtB: claimB.retrievedAt,
      evidenceExcerptB: claimB.evidenceExcerpt,
      status: 'CONFLICT',
      requiresReview: true,
    };
  }

  conflictIdempotencyKey(organizationId: string, companyId: string, contactId: string | null, conflict: VerificationConflictLog): string {
    return createHash('sha256').update(JSON.stringify({
      organizationId,
      companyId,
      contactId,
      fieldName: conflict.fieldName,
      valueA: conflict.valueA,
      valueB: conflict.valueB,
      sourceUrlA: conflict.sourceUrlA,
      sourceUrlB: conflict.sourceUrlB,
    })).digest('hex');
  }

  private collectClaims(field: string, evidence: VerificationEvidence[]): FieldClaim[] {
    const claims: FieldClaim[] = [];
    const seen = new Set<string>();
    for (const item of evidence) {
      const value = this.evidenceValue(item);
      if (!value) continue;
      const metadata = this.metadata(item);
      if (metadata.field !== field) continue;
      const claim = this.toClaim(item, value);
      const key = `${this.sourceKey(item)}:${this.normalize(field, value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push(claim);
    }
    return claims;
  }

  private independentSourceCount(claims: Array<FieldClaim | VerificationEvidence>): number {
    return new Set(claims.map((claim) => {
      if ('sourceUrl' in claim && 'evidenceExcerpt' in claim && !('evidenceText' in claim)) {
        return independentSourceKey({
          provider: claim.provider,
          sourceType: claim.sourceType,
          sourceUrl: claim.sourceUrl,
        });
      }
      return this.sourceKey(claim as VerificationEvidence);
    })).size;
  }

  private toClaim(item: VerificationEvidence, value: string): FieldClaim {
    return {
      value,
      sourceType: item.sourceType ?? item.provider ?? 'unknown',
      sourceUrl: item.canonicalUrl ?? item.sourceUrl,
      retrievedAt: item.retrievedAt,
      evidenceExcerpt: item.evidenceText,
      evidenceId: item.id,
      provider: item.provider,
    };
  }

  private evidenceMatches(item: VerificationEvidence, field: string, value: string) {
    const metadata = this.metadata(item);
    if (metadata.field === field && typeof metadata.value === 'string') {
      return this.normalize(field, metadata.value) === this.normalize(field, value);
    }
    if (field === 'email') return item.evidenceText.toLowerCase().includes(value.toLowerCase());
    if (field === 'phone') return item.evidenceText.replace(/\D/g, '').includes(value.replace(/\D/g, ''));
    return item.evidenceText.toLowerCase().includes(value.toLowerCase());
  }

  private evidenceValue(item: VerificationEvidence) {
    const value = this.metadata(item).value;
    return typeof value === 'string' ? value : null;
  }

  private normalize(field: string, value: string) {
    return field === 'email' ? value.toLowerCase().trim() : field === 'phone' ? value.replace(/\D/g, '') : value.toLowerCase().trim();
  }

  private metadata(item: VerificationEvidence) {
    return typeof item.metadata === 'object' && item.metadata !== null ? item.metadata as Record<string, unknown> : {};
  }

  private sourceKey(item: VerificationEvidence) {
    return independentSourceKey(item);
  }
}
