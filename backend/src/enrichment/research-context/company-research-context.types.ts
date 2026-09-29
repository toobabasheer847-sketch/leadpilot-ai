/**
 * Phase N — internal research reuse layer (not persisted evidence).
 * Cached/reused page bodies and search hits must NEVER count as additional
 * independent verification sources; they are transport reuse only.
 */

export interface ResearchContextPage {
  url: string;
  finalUrl: string;
  title?: string | null;
  content: string;
  contentType?: string;
  statusCode?: number;
  fetchedAt: string;
  /** Where the page body was first obtained (enrichment | deep_research | decision_maker | employee_size). */
  sourceStage: string;
}

export interface ResearchContextSearchHit {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  retrievedAt: string;
  query: string;
}

export interface ResearchContextPersonHint {
  fullName: string;
  title?: string | null;
  sourceUrl: string;
  excerpt: string;
}

export interface ResearchContextCompanyFields {
  name?: string | null;
  website?: string | null;
  domain?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  aliases?: string[];
  socialUrls?: string[];
  discoverySourceUrls?: string[];
}

export interface CompanyResearchContext {
  organizationId: string;
  companyId: string;
  searchExecutionId: string | null;
  company: ResearchContextCompanyFields;
  pages: ResearchContextPage[];
  searchHits: ResearchContextSearchHit[];
  /** Normalized query strings already issued for this company/execution. */
  queriesIssued: string[];
  personHints: ResearchContextPersonHint[];
  updatedAt: string;
}

export interface ResearchContextStats {
  cacheHits: number;
  cacheMisses: number;
  websiteReuseCount: number;
  providerQueriesAvoided: number;
  researchContextHits: number;
  duplicateQueryPrevented: number;
  additionalQueriesRequired: number;
  contextsCreated: number;
}

export type ResearchContextKeyParts = {
  organizationId: string;
  companyId: string;
  searchExecutionId?: string | null;
};

export const RESEARCH_CONTEXT_TTL_MS = 30 * 60 * 1000;
export const RESEARCH_CONTEXT_MAX_PAGES = 12;
export const RESEARCH_CONTEXT_MAX_BODY_CHARS = 200_000;
