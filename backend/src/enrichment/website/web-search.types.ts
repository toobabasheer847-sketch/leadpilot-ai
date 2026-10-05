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
    sourceUrl: string;
    evidenceExcerpt: string;
    retrievedAt: string;
  }>;
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
