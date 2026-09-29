import type { SearchPlan } from '../../search/types/search-plan.types';
import type { ScoreBreakdown } from '../../scoring/types/scoring.types';

export type QualificationStatus = 'QUALIFIED' | 'NOT_QUALIFIED' | 'NEEDS_REVIEW';
export type CriterionResultCode = 'MATCH' | 'NO_MATCH' | 'NOT_FOUND' | 'NEEDS_REVIEW';

export interface QualificationCriteria {
  industry: string[];
  leadTypes: string[];
  locations: SearchPlan['locations'];
  companySize?: SearchPlan['companySize'];
  requiredRoles: string[];
  requiredFields: string[];
  optionalFields: string[];
  companyRequiredFields: string[];
  personRequiredFields: string[];
  preferredFields: string[];
  verificationRequiredFields: string[];
  /** Requested company social platforms (optional unless also listed in requiredFields). */
  socialPlatforms: string[];
  /** True when a person/decision-maker email was requested (company email must not satisfy it). */
  personEmailRequired: boolean;
  /** True when a company-level email was requested. */
  companyEmailRequired: boolean;
  /** True when the plan asked for a verified email. */
  verifiedEmailRequired: boolean;
  /** Prompt exclusions preserved for qualification (evidence-based). */
  exclusions: string[];
  /** Plan count semantics retained for audit/traceability (not a per-lead gate). */
  requestedCount?: number;
  countIntent?: SearchPlan['countIntent'];
  minimumScore?: number;
}

export interface CriterionEvidence {
  criterion: string;
  result: CriterionResultCode;
  source: string | null;
  sourceUrl: string | null;
  evidenceExcerpt: string | null;
  retrievedAt: string | null;
  verificationStatus: string | null;
  evidenceId?: string | null;
  required: boolean;
  message: string;
}

export interface QualificationDecision {
  status: QualificationStatus;
  criteria: QualificationCriteria;
  criterionResults: CriterionEvidence[];
  qualifiedReasons: string[];
  disqualifiedReasons: string[];
  needsReviewReasons: string[];
  missingOptional: string[];
  score: number | null;
  scoreBand: string | null;
  scoreBreakdown: ScoreBreakdown | null;
}

export interface QualificationJobData {
  searchExecutionId: string;
  organizationId: string;
  force: boolean;
  idempotencyKey: string;
  correlationId?: string;
}

export interface QualificationContext {
  company: {
    id: string;
    name: string;
    website: string | null;
    email: string | null;
    phone: string | null;
    description: string | null;
    category: string | null;
    investorType: string | null;
    employeeCount: number | null;
    employeeRange: string | null;
    verificationStatus: string;
  };
  /** Company social profiles discovered for the lead (never fabricated). */
  socialProfiles: Array<{ platform: string; profileUrl: string | null }>;
  location: { city: string | null; state: string | null; country: string | null; postalCode: string | null } | null;
  contacts: Array<{
    id: string;
    fullName: string | null;
    title: string | null;
    normalizedRole: string | null;
    companyRelationship: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    facebookUrl: string | null;
    instagramUrl: string | null;
    youtubeUrl: string | null;
    verificationStatus: string;
  }>;
  evidence: Array<{
    id: string;
    evidenceType: string;
    sourceUrl: string;
    evidenceText: string;
    provider: string | null;
    sourceType: string | null;
    retrievedAt: Date | null;
    metadata: unknown;
  }>;
  verifications: Array<{
    field: string;
    status: string;
    fieldValue: string | null;
    evidenceId: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  conflicts: Array<{ fieldName: string; requiresReview: boolean; resolutionStatus: string }>;
  classification: {
    decision: string;
    confidence: number | null;
    category: string;
    investorType: string;
    positiveEvidence: unknown;
    negativeEvidence: unknown;
    missingEvidence: unknown;
    exclusionReason: string | null;
  } | null;
  score: { value: number; band: string; breakdown: ScoreBreakdown } | null;
}
