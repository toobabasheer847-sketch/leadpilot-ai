export interface WebSearchQuery {
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  category?: string | null;
}

export interface WebSearchResult {
  title: string;
  url: string;
  /** Official company site when it differs from the cited evidence URL. */
  website?: string;
  extractedContacts?: Array<{
    fullName: string;
    title: string;
    email?: string;
    linkedinUrl?: string;
    facebookUrl?: string;
    instagramUrl?: string;
    sourceUrl: string;
    evidenceExcerpt: string;
    retrievedAt: string;
  }>;
  companyEmail?: string;
  socialProfiles?: Array<{
    platform: 'linkedin' | 'facebook' | 'instagram';
    profileUrl: string;
    role: 'company' | 'decision_maker';
  }>;
  citationStatus?: 'CITATION_PRESENT' | 'CITATION_ANNOTATION_MISSING';
  snippet: string;
  source: string;
  retrievedAt: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: WebSearchQuery): Promise<WebSearchResult[]>;
  searchText?(query: string, options?: { maxResults?: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

export const WEB_SEARCH_PROVIDER = Symbol('WEB_SEARCH_PROVIDER');
