export const CLASSIFICATION_DECISIONS = ['QUALIFIED', 'NOT_QUALIFIED', 'INSUFFICIENT_EVIDENCE'] as const;
export type ClassificationDecision = (typeof CLASSIFICATION_DECISIONS)[number];

export const INVESTOR_TYPES = [
  'CASH_HOME_BUYER',
  'FIX_AND_FLIP',
  'BUY_AND_HOLD',
  'BRRRR',
  'COMMERCIAL_INVESTOR',
  'LAND_INVESTOR',
  'MULTIFAMILY_INVESTOR',
  'REAL_ESTATE_INVESTOR_OTHER',
  'NOT_DETERMINED',
] as const;
export type InvestorType = (typeof INVESTOR_TYPES)[number];

export const VERIFICATION_STATUSES = ['FOUND', 'NOT_FOUND'] as const;

export interface ClassificationCriteria {
  category: string;
  targetType?: string;
  location?: { country?: string; states?: string[] };
  companySize?: { min?: number; max?: number };
  requiredSignals?: string[];
  excludedSignals?: string[];
  customCriteria?: string;
}

export interface NormalizedEvidence {
  evidenceId: string;
  sourceType: string;
  sourceUrl: string;
  title: string | null;
  excerpt: string;
  retrievedAt: string;
}

export interface ClassificationInput {
  company: {
    id: string;
    name: string;
    description: string | null;
    website: string | null;
    category: string | null;
    investorType: string | null;
    investmentStrategy: string | null;
    employeeCount: number | null;
    employeeRange: string | null;
  };
  criteria: ClassificationCriteria;
  evidence: NormalizedEvidence[];
}

export interface EvidenceReference {
  evidenceId: string;
  reason: string;
}

export interface ClassificationResult {
  decision: ClassificationDecision;
  confidence: number;
  category: string;
  investorType: InvestorType;
  reasons: string[];
  positiveEvidence: EvidenceReference[];
  negativeEvidence: EvidenceReference[];
  missingEvidence: string[];
  exclusionReason: string | null;
  companySizeVerification: 'FOUND' | 'NOT_FOUND';
  locationStatus: 'FOUND' | 'NOT_FOUND';
}
