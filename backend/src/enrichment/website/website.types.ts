export type EnrichmentStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export type EvidenceType =
  | 'WEBSITE'
  | 'ABOUT_PAGE'
  | 'CONTACT_PAGE'
  | 'SERVICES_PAGE'
  | 'INVESTMENT_PAGE'
  | 'STRUCTURED_DATA'
  | 'SOCIAL_LINK'
  | 'META_DATA';

export interface SourceEvidence {
  field: string;
  value: string;
  sourceUrl: string;
  evidenceExcerpt: string;
  retrievedAt: string;
  evidenceType: EvidenceType;
}

export interface WebsitePageResult {
  url: string;
  finalUrl: string;
  title?: string | null;
  description?: string | null;
  canonicalUrl?: string | null;
  ogTitle?: string | null;
  ogUrl?: string | null;
  content: string;
  contentType: string;
  statusCode: number;
  depth?: number;
}

export interface WebsiteDiscoveryInput {
  existingWebsite?: string | null;
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  sourceWebsites?: string[];
  attemptSourceUrl?: string | null;
  attemptSourceType?: string | null;
  category?: string | null;
}

export interface WebsiteDiscoveryOutcome {
  website: string | null;
  status: 'FOUND' | 'NOT_FOUND' | 'INVALID';
  page?: WebsitePageResult;
  pages?: WebsitePageResult[];
  reason?: string;
  provider?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  retrievedAt?: string | null;
  evidenceExcerpt?: string | null;
  searchHit?: {
    title: string;
    url: string;
    snippet: string;
    source: string;
    retrievedAt: string;
  } | null;
  rejectedSearchHits?: Array<{
    reason: string;
    hit: {
      title: string;
      url: string;
      snippet: string;
      source: string;
      retrievedAt: string;
    };
  }>;
  clearStoredWebsite?: boolean;
}

export interface WebsiteFetchResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  body: string;
  title?: string | null;
  description?: string | null;
  canonicalUrl?: string | null;
  redirectCount: number;
}

export interface ExtractedCompanyFields {
  companyName?: string | null;
  description?: string | null;
  phone?: string | null;
  publicEmail?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  services?: string[];
  marketsServed?: string[];
  propertyTypes?: string[];
  investmentStrategy?: string | null;
  socialLinks: string[];
  investmentSignals: string[];
  evidence: SourceEvidence[];
}

export interface CompanyEnrichmentJobData {
  companyId: string;
  organizationId: string;
  searchExecutionId?: string | null;
  correlationId?: string;
  idempotencyKey?: string;
}
