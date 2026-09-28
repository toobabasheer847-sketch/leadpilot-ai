export type EntityType = 'COMPANY' | 'CONTACT';
export type MatchType = 'EXACT_MATCH' | 'STRONG_MATCH' | 'POSSIBLE_MATCH' | 'POTENTIAL_DUPLICATE' | 'NO_MATCH' | 'CONFLICT';
export type DuplicateStatus =
  | 'PENDING'
  | 'AUTO_DUPLICATE'
  | 'REVIEW_REQUIRED'
  | 'NEEDS_REVIEW'
  | 'POTENTIAL_DUPLICATE'
  | 'CONFIRMED_DUPLICATE'
  | 'NOT_DUPLICATE'
  | 'CONFLICT'
  | 'MERGED';

export interface MatchSignal {
  type: string;
  matched: boolean;
  weight: number;
  value?: string;
}

export interface MatchDecision {
  entityType: EntityType;
  recordA: string;
  recordB: string;
  matchType: MatchType;
  status: DuplicateStatus;
  confidence: number;
  signals: MatchSignal[];
  reason: string;
  /** When true, pipeline may auto-merge into an elected master. */
  autoMergeEligible?: boolean;
}

export interface NormalizedCompany {
  id: string;
  name: string;
  domain: string | null;
  phone: string | null;
  placeId: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  email: string | null;
  emailDomain: string | null;
  socialUrls: string[];
  externalIds: string[];
  phoneVerified?: boolean;
  emailVerified?: boolean;
  verificationStatus?: string | null;
  evidenceCount?: number;
  contactCount?: number;
  fieldCompleteness?: number;
}

export interface NormalizedContact {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  socialUrls: string[];
  title: string | null;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  verificationStatus?: string | null;
  evidenceCount?: number;
  fieldCompleteness?: number;
}

export interface MasterCandidate {
  id: string;
  verificationStatus?: string | null;
  evidenceCount: number;
  contactCount?: number;
  fieldCompleteness: number;
  hasWebsite?: boolean;
  hasPhone?: boolean;
  hasEmail?: boolean;
}
