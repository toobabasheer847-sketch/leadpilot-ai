import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboundRequestError, OutboundRequestService } from '../../common/outbound-request.service';
import { WebSearchError } from './web-search.error';
import { buildWebSearchQuery } from './web-search.query';
import { WebSearchProvider, WebSearchQuery, WebSearchResult } from './web-search.types';

const DEFAULT_TAVILY_URL = 'https://api.tavily.com/search';

@Injectable()
export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly name = 'tavily';
  private readonly logger = new Logger(TavilyWebSearchProvider.name);

  constructor(
    private readonly outbound: OutboundRequestService,
    private readonly config: ConfigService,
  ) {
    const provider = (this.config.get<string>('webSearch.provider') || 'tavily').trim().toLowerCase();
    const keyPresent = Boolean(this.config.get<string>('webSearch.tavilyApiKey')?.trim());
    const url = this.config.get<string>('webSearch.tavilyApiUrl')?.trim() || DEFAULT_TAVILY_URL;
    this.logger.log(`web_search.configured provider=${provider} url=${url} TAVILY_API_KEY_PRESENT=${keyPresent}`);
  }

  async search(query: WebSearchQuery): Promise<WebSearchResult[]> {
    const selected = (this.config.get<string>('webSearch.provider') || 'tavily').trim().toLowerCase();
    if (selected !== 'tavily') {
      throw new WebSearchError('CONFIGURATION_ERROR', 'web_search', 'search', false, 'Web search provider is not configured.');
    }
    const apiKey = this.config.get<string>('webSearch.tavilyApiKey')?.trim();
    if (!apiKey) {
      throw new WebSearchError('CONFIGURATION_ERROR', this.name, 'search', false, 'Web search provider is not configured.');
    }
    const text = buildWebSearchQuery(query);
    if (!text) return [];

    const endpoint = this.config.get<string>('webSearch.tavilyApiUrl')?.trim() || DEFAULT_TAVILY_URL;
    const timeoutMs = this.config.get<number>('webSearch.timeoutMs', 10000);
    const body = {
      query: text,
      max_results: this.maxResults(),
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    };

    let response: Response;
    try {
      response = await this.outbound.fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }, timeoutMs);
    } catch (error) {
      if (error instanceof OutboundRequestError && /timed out/i.test(error.message)) {
        throw new WebSearchError('PROVIDER_TIMEOUT', this.name, 'search', true, 'Web search provider timed out.');
      }
      throw new WebSearchError('PROVIDER_HTTP_ERROR', this.name, 'search', true, 'Web search provider is unavailable.');
    }

    if (response.status === 429) throw new WebSearchError('PROVIDER_RATE_LIMIT', this.name, 'search', true, 'Web search provider rate limit reached.');
    if (response.status === 401 || response.status === 403) throw new WebSearchError('CONFIGURATION_ERROR', this.name, 'search', false, 'Web search provider authentication failed.');
    if (response.status >= 500) throw new WebSearchError('PROVIDER_HTTP_ERROR', this.name, 'search', true, `Web search provider returned HTTP ${response.status}.`);
    if (response.status < 200 || response.status >= 300) throw new WebSearchError('PROVIDER_HTTP_ERROR', this.name, 'search', false, `Web search provider returned HTTP ${response.status}.`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebSearchError('INVALID_PROVIDER_RESPONSE', this.name, 'search', false, 'Web search provider returned an invalid response.');
    }
    return this.parseResults(payload);
  }

  private maxResults() {
    const configured = this.config.get<number>('webSearch.maxResults', 5);
    if (!Number.isFinite(configured)) return 5;
    return Math.min(10, Math.max(1, Math.trunc(configured)));
  }

  private parseResults(payload: unknown): WebSearchResult[] {
    if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) {
      throw new WebSearchError('INVALID_PROVIDER_RESPONSE', this.name, 'search', false, 'Web search provider returned an invalid response.');
    }
    const retrievedAt = new Date().toISOString();
    const results: WebSearchResult[] = [];
    for (const item of payload.results) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { title?: unknown; url?: unknown; content?: unknown };
      if (typeof record.url !== 'string' || !/^https?:\/\//i.test(record.url)) continue;
      results.push({
        title: typeof record.title === 'string' ? record.title.slice(0, 300) : '',
        url: record.url,
        snippet: typeof record.content === 'string' ? record.content.slice(0, 500) : '',
        source: this.name,
        retrievedAt,
      });
    }
    return results;
  }
}
