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
  snippet: string;
  source: string;
  retrievedAt: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: WebSearchQuery): Promise<WebSearchResult[]>;
}

export const WEB_SEARCH_PROVIDER = Symbol('WEB_SEARCH_PROVIDER');
