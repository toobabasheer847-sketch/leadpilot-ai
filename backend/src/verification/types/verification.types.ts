export type VerificationStatus = 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED' | 'NOT_FOUND' | 'CONFLICT' | 'NEEDS_REVIEW' | 'INVALID';
export type VerificationType = 'SOURCE_EVIDENCE' | 'SYNTAX_CHECK' | 'DOMAIN_CHECK' | 'PROVIDER_CHECK' | 'CROSS_SOURCE_MATCH' | 'MANUAL_REVIEW';

export interface VerificationEvidence {
  id: string;
  sourceUrl: string;
  evidenceType: string;
  evidenceText: string;
  metadata: unknown;
  retrievedAt: Date | null;
  canonicalUrl?: string | null;
  sourceType?: string | null;
  provider?: string | null;
}

export interface VerificationInput {
  field: string;
  value: string | null;
  evidence: VerificationEvidence[];
}

export interface FieldClaim {
  value: string;
  sourceType: string;
  sourceUrl: string;
  retrievedAt: Date | null;
  evidenceExcerpt: string;
  evidenceId?: string;
  provider?: string | null;
}

export interface VerificationConflictLog {
  fieldName: string;
  valueA: string;
  valueB: string;
  sourceTypeA: string;
  sourceUrlA: string;
  retrievedAtA: Date | null;
  evidenceExcerptA: string;
  sourceTypeB: string;
  sourceUrlB: string;
  retrievedAtB: Date | null;
  evidenceExcerptB: string;
  status: 'CONFLICT';
  requiresReview: true;
}

export interface VerificationSignal {
  status: VerificationStatus;
  verificationType: VerificationType;
  provider: string;
  evidenceId?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  conflict?: VerificationConflictLog;
  provenance?: {
    sourceType: string | null;
    sourceUrl: string | null;
    retrievedAt: Date | null;
    evidenceExcerpt: string | null;
  };
}

export interface VerificationResult extends VerificationSignal {
  field: string;
  value: string | null;
  checkedAt: string;
}

export interface VerificationJobData {
  companyId: string;
  contactId: string | null;
  organizationId: string;
  searchExecutionId: string | null;
  force: boolean;
  idempotencyKey: string;
  correlationId?: string;
}

export interface EntityMatchClaim {
  sourceRecordId: string;
  sourceType: string;
  sourceUrl: string;
  retrievedAt: Date;
  name: string | null;
  website: string | null;
  phone: string | null;
}

export interface CrossSourceEntityMatchResult {
  sameEntity: boolean;
  confidence: number;
  signals: string[];
  conflicts: VerificationConflictLog[];
}
