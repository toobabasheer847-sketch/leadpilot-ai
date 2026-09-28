import type { SearchPlan } from '../../search/types/search-plan.types';
import type { WebSearchResult } from '../../enrichment/website/web-search.types';
import { collectWebCompanyCandidates } from '../providers/web-search/company-discovery.assess';
import type { NormalizedSourceResult } from '../types/source.types';
import { discoveryProviderFailure, resolveDiscoveryFallback } from './discovery-fallback';

const plan: SearchPlan = {
  industry: ['real_estate'],
  leadTypes: ['real_estate_investor'],
  locations: [{ country: 'US', state: 'Texas' }],
  companyFields: [],
  maxResults: 10,
  unresolvedCriteria: [],
};

function company(name: string, website: string, city = 'Austin'): NormalizedSourceResult {
  return {
    externalId: `id:${website}`,
    name,
    website,
    sourceUrl: website,
    address: { city, state: 'Texas', country: 'US' },
  };
}

function hit(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return {
    title: 'Oak Stream Investors | Home',
    url: 'https://oakstream.example/',
    snippet: 'Oak Stream Investors is a real estate investment company in Austin, Texas.',
    source: 'tavily',
    retrievedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('discovery provider fallback', () => {
  it('continues with web discovery when OpenStreetMap is rate limited', () => {
    const webCompany = company('Cedar Range Capital', 'https://cedarrange.example', 'Dallas');
    const resolved = resolveDiscoveryFallback({
      primary: { results: [], error: 'OpenStreetMap provider rate limit reached.' },
      web: { results: [webCompany], error: null },
    });
    expect(resolved.web).toEqual([webCompany]);
    expect(discoveryProviderFailure(resolved.web.length, 'osm', 'OpenStreetMap provider rate limit reached.', { error: null })).toBeNull();
  });

  it('keeps partial OpenStreetMap companies and continues web discovery for the rest', async () => {
    const alpha = company('Oak Stream Investors', 'https://oakstream.example/');
    const beta = company('Beta Holdings', 'https://beta.example', 'Dallas');
    const search = jest.fn()
      .mockResolvedValueOnce([hit()])
      .mockResolvedValueOnce([hit({
        title: 'Cedar Range Capital | Home',
        url: 'https://cedarrange.example/',
        snippet: 'Cedar Range Capital is a real estate investment company in Houston, Texas.',
      })]);
    const collected = await collectWebCompanyCandidates(plan, 1, search, { maxQueries: 4, delayMs: 0, exclude: [alpha] });
    const resolved = resolveDiscoveryFallback({
      primary: { results: [alpha, beta], error: 'OpenStreetMap provider rate limit reached.' },
      web: { results: [...collected.results, alpha], error: null },
    });

    expect(collected.results.map((result) => result.name)).toEqual(['Cedar Range Capital']);
    expect(search).toHaveBeenCalledTimes(2);
    expect(resolved.primary.map((result) => result.name)).toEqual(['Oak Stream Investors', 'Beta Holdings']);
    expect(resolved.web.map((result) => result.name)).toEqual(['Cedar Range Capital']);
    expect(resolved.duplicatesRemoved).toBe(1);
    expect(discoveryProviderFailure(3, 'osm', 'OpenStreetMap provider rate limit reached.', { error: null })).toBeNull();
  });

  it('does not treat a successful empty web fallback as a hard provider failure', () => {
    expect(discoveryProviderFailure(
      0,
      'osm',
      'OpenStreetMap provider rate limit reached.',
      { error: null },
    )).toBeNull();
  });

  it('reports a provider failure when every discovery provider fails', () => {
    const failure = discoveryProviderFailure(
      0,
      'osm',
      'OpenStreetMap provider rate limit reached.',
      { error: 'Web search provider rate limit reached.' },
    );
    expect(failure).toBe('Discovery providers failed. OpenStreetMap: OpenStreetMap provider rate limit reached. Web search: Web search provider rate limit reached.');
    expect(failure).not.toMatch(/not found within budget/i);
    expect(discoveryProviderFailure(0, 'osm', 'OpenStreetMap provider rate limit reached.', null))
      .toBe('Discovery providers failed. OpenStreetMap: OpenStreetMap provider rate limit reached.');
    expect(discoveryProviderFailure(0, 'osm', null, { error: null })).toBeNull();
  });
});
