export type VerificationStatus = 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID';
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

export interface VerificationSignal {
  status: VerificationStatus;
  verificationType: VerificationType;
  provider: string;
  evidenceId?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
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
