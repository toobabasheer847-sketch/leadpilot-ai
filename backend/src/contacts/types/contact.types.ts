export type ContactStatus = 'DISCOVERED' | 'PARTIALLY_VERIFIED' | 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_FOUND';
export type VerificationStatus = 'VERIFIED' | 'SUPPORTED' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_VERIFIED';

export interface ContactEvidenceEntry {
  field: string;
  value: string;
  sourceUrl: string;
  evidenceExcerpt: string;
  retrievedAt: string;
  evidenceType: string;
}

export interface ContactCandidate {
  fullName: string;
  title: string | null;
  originalTitle?: string | null;
  normalizedRole?: string | null;
  companyRelationship?: string | null;
  professionalBio?: string | null;
  email?: string | null;
  emailStatus?: 'FOUND' | 'VERIFIED' | 'NOT_FOUND' | 'UNVERIFIED';
  phone?: string | null;
  phoneStatus?: 'FOUND' | 'VERIFIED' | 'NOT_FOUND' | 'UNVERIFIED';
  linkedinUrl?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  youtubeUrl?: string | null;
  companyName: string;
  sourceUrl: string;
  evidence: ContactEvidenceEntry[];
  normalizedName?: string;
  status: ContactStatus;
  verificationStatus: VerificationStatus;
}

export interface ContactDiscoveryContext {
  companyId: string;
  organizationId: string;
  searchExecutionId?: string | null;
  companyWebsite?: string | null;
  correlationId?: string;
}

export interface ContactDiscoveryResult {
  candidates: ContactCandidate[];
}

export interface IdentityMatchResult {
  samePerson: boolean;
  confidence: number;
  signals: string[];
}

export interface CompanyLike {
  id: string;
  name: string;
  website?: string | null;
}
