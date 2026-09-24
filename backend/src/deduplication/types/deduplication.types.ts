export type EntityType = 'COMPANY' | 'CONTACT';
export type MatchType = 'EXACT_MATCH' | 'STRONG_MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH' | 'CONFLICT';
export type DuplicateStatus = 'PENDING' | 'AUTO_DUPLICATE' | 'REVIEW_REQUIRED' | 'CONFIRMED_DUPLICATE' | 'NOT_DUPLICATE' | 'CONFLICT';

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
  emailDomain: string | null;
  socialUrls: string[];
}

export interface NormalizedContact {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  socialUrls: string[];
  title: string | null;
}
