import { MetricsService } from '../../common/observability/metrics.service';
import { mapWithConcurrency } from '../../common/concurrency';
import { WebsiteNormalizerService } from '../website/website-normalizer.service';
import { WebsiteContactProvider } from '../../contacts/providers/website-contact.provider';
import { ContactExtractorService } from '../../contacts/extraction/contact-extractor.service';
import { PersonDiscoveryService } from '../../contacts/discovery/person-discovery.service';
import { PersonIdentityMatcherService } from '../../contacts/matching/person-identity-matcher.service';
import { PersonCandidateService } from '../../contacts/discovery/person-candidate.service';
import { ConfigService } from '@nestjs/config';
import { CompanyResearchContextService } from './company-research-context.service';

function teamHtml(company: string, name: string, title: string) {
  return `<html><body><h1>${company}</h1><p>${name} is the ${title} of ${company}.</p><a href="https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}">${name}</a></body></html>`;
}

describe('Phase N research reuse', () => {
  let metrics: MetricsService;
  let context: CompanyResearchContextService;

  beforeEach(() => {
    metrics = new MetricsService();
    context = new CompanyResearchContextService(new WebsiteNormalizerService(), metrics);
    context.resetStatsForTests();
  });

  it('A. creates research context for 300 companies with organization isolation', async () => {
    const keys = Array.from({ length: 300 }, (_, index) => ({
      organizationId: 'org-a',
      companyId: `company-${index + 1}`,
      searchExecutionId: 'exec-n',
    }));
    await mapWithConcurrency(keys, 8, async (key) => {
      await context.mergePages(key, [{
        url: `https://c${key.companyId}.example/`,
        finalUrl: `https://c${key.companyId}.example/`,
        content: teamHtml(`Co ${key.companyId}`, 'Ada Example', 'CEO'),
        title: 'Home',
      }], 'enrichment', { name: `Co ${key.companyId}` });
      return key.companyId;
    }, { maxConcurrency: 16 });

    const first = await context.getPages(keys[0]!);
    const last = await context.getPages(keys[299]!);
    expect(first).toHaveLength(1);
    expect(last).toHaveLength(1);
    expect(first[0]?.content).toContain('company-1');
    expect(last[0]?.content).toContain('company-300');

    const foreign = await context.getPages({ organizationId: 'org-b', companyId: 'company-1', searchExecutionId: 'exec-n' });
    expect(foreign).toHaveLength(0);
    expect(context.getStats().contextsCreated).toBe(300);
  });

  it('B. duplicate website merges reuse pages and do not invent independence', async () => {
    const key = { organizationId: 'org-a', companyId: 'c1', searchExecutionId: 'exec-1' };
    await context.mergePages(key, [{
      url: 'https://oak.example/',
      finalUrl: 'https://oak.example/',
      content: teamHtml('Oak Stream', 'Ada Example', 'CEO'),
    }], 'enrichment');
    await context.mergePages(key, [{
      url: 'https://www.oak.example/',
      finalUrl: 'https://oak.example/',
      content: teamHtml('Oak Stream', 'Ada Example', 'CEO'),
    }], 'deep_research');

    const pages = await context.get(key);
    expect(pages?.pages).toHaveLength(1);
    expect(context.getStats().websiteReuseCount).toBeGreaterThanOrEqual(1);
    // Reused transport must not claim a second independent source URL for the same page.
    expect(new Set(pages?.pages.map((page) => page.finalUrl)).size).toBe(1);
  });

  it('C. decision-maker discovery consumes existing research pages before crawling', async () => {
    const key = { organizationId: 'org-a', companyId: 'c1', searchExecutionId: 'exec-1' };
    await context.mergePages(key, [{
      url: 'https://oak.example/team',
      finalUrl: 'https://oak.example/team',
      content: teamHtml('Oak Stream Investors', 'Ada Example', 'CEO'),
    }], 'enrichment');

    const discover = jest.fn().mockResolvedValue({ pages: [] });
    const provider = new WebsiteContactProvider(
      new ContactExtractorService({ get: () => ['CEO', 'FOUNDER'] } as ConfigService),
      { discover } as never,
      new WebsiteNormalizerService(),
      context,
    );
    const result = await provider.discover(
      { id: 'c1', name: 'Oak Stream Investors', website: 'https://oak.example/' },
      { companyId: 'c1', organizationId: 'org-a', searchExecutionId: 'exec-1', decisionMakerRoles: ['CEO'] },
    );
    expect(discover).not.toHaveBeenCalled();
    expect(result.candidates.some((candidate) => candidate.fullName === 'Ada Example')).toBe(true);
    expect(result.candidates[0]?.linkedinUrl).toMatch(/linkedin\.com\/in\//);
    // Company LinkedIn must not be treated as person LinkedIn — only /in/ profiles.
    expect(result.candidates[0]?.linkedinUrl).not.toMatch(/linkedin\.com\/company\//);
  });

  it('D. missing information still triggers fallback search; duplicate queries are prevented', async () => {
    const searchText = jest.fn().mockResolvedValue([
      {
        title: 'Bob Founder — Oak',
        url: 'https://www.linkedin.com/in/bob-founder',
        snippet: 'Bob Founder is Founder of Oak Stream Investors.',
        source: 'tavily',
        retrievedAt: new Date().toISOString(),
      },
    ]);
    const websiteProvider = {
      discover: jest.fn().mockResolvedValue({ candidates: [] }),
    };
    const service = new PersonDiscoveryService(
      websiteProvider as never,
      new PersonIdentityMatcherService(),
      new PersonCandidateService(new ContactExtractorService({ get: () => [] } as ConfigService)),
      context,
      undefined,
      { searchText } as never,
    );

    const first = await service.discover(
      { id: 'c2', name: 'Oak Stream Investors', website: 'https://oak.example/' },
      { companyId: 'c2', organizationId: 'org-a', searchExecutionId: 'exec-1', decisionMakerRoles: ['Founder'], emailRequested: false },
    );
    expect(searchText).toHaveBeenCalled();
    expect(first.candidates.length).toBeGreaterThan(0);

    const callsAfterFirst = searchText.mock.calls.length;
    const second = await service.discover(
      { id: 'c2', name: 'Oak Stream Investors', website: 'https://oak.example/' },
      { companyId: 'c2', organizationId: 'org-a', searchExecutionId: 'exec-1', decisionMakerRoles: ['Founder'], emailRequested: false },
    );
    expect(searchText.mock.calls.length).toBe(callsAfterFirst);
    expect(second.candidates.length).toBeGreaterThan(0);
    expect(context.getStats().duplicateQueryPrevented).toBeGreaterThan(0);
  });

  it('E. one company failure does not stop the remaining 299', async () => {
    const keys = Array.from({ length: 300 }, (_, index) => ({
      organizationId: 'org-load',
      companyId: `company-${index}`,
      searchExecutionId: 'exec-load',
    }));
    let failures = 0;
    let successes = 0;
    let maxInFlight = 0;
    let inFlight = 0;
    await mapWithConcurrency(keys, 8, async (key) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (key.companyId.endsWith('-13') || key.companyId.endsWith('-113') || key.companyId.endsWith('-213')) {
          failures += 1;
          throw new Error('provider timeout');
        }
        await context.mergePages(key, [{
          url: `https://${key.companyId}.example/`,
          finalUrl: `https://${key.companyId}.example/`,
          content: `<p>${key.companyId}</p>`,
        }], 'enrichment');
        successes += 1;
      } catch {
        return null;
      } finally {
        inFlight -= 1;
      }
      return key.companyId;
    }, { maxConcurrency: 16 });

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(successes).toBe(297);
    expect(failures).toBe(3);
    expect(await context.getPages(keys[0]!)).toHaveLength(1);
  });

  it('F. metrics cover Phase N reuse counters without secrets', () => {
    metrics.increment('research_cache_hits', { layer: 'memory' });
    metrics.increment('research_cache_misses', {});
    metrics.increment('website_reuse_count', { stage: 'enrichment' });
    metrics.increment('provider_queries_avoided', {});
    metrics.increment('research_context_hits', { kind: 'pages' });
    metrics.increment('duplicate_query_prevented', {});
    metrics.increment('additional_queries_required', {});
    metrics.observe('per_company_research_duration_ms', 42, { company: 'abcd1234' });
    const output = metrics.toPrometheus();
    expect(output).toContain('research_cache_hits');
    expect(output).toContain('website_reuse_count');
    expect(output).toContain('provider_queries_avoided');
    expect(output).toContain('duplicate_query_prevented');
    expect(output).toContain('per_company_research_duration_ms');
    expect(output).not.toMatch(/redis:\/\/|api[_-]?key|password|secret/i);
  });

  it('G. person hints do not become VERIFIED and company/person social stay separated', async () => {
    const key = { organizationId: 'org-a', companyId: 'c3', searchExecutionId: 'exec-1' };
    await context.addPersonHints(key, [{
      fullName: 'Ada Example',
      title: 'CEO',
      sourceUrl: 'https://oak.example/about',
      excerpt: 'Ada Example is CEO of Oak Stream Investors.',
    }]);
    const websiteProvider = { discover: jest.fn().mockResolvedValue({ candidates: [] }) };
    const service = new PersonDiscoveryService(
      websiteProvider as never,
      new PersonIdentityMatcherService(),
      new PersonCandidateService(new ContactExtractorService({ get: () => [] } as ConfigService)),
      context,
    );
    const result = await service.discover(
      { id: 'c3', name: 'Oak Stream Investors', website: 'https://oak.example/' },
      { companyId: 'c3', organizationId: 'org-a', searchExecutionId: 'exec-1', decisionMakerRoles: ['CEO'] },
    );
    expect(result.candidates[0]?.fullName).toBe('Ada Example');
    expect(result.candidates[0]?.verificationStatus).toBe('NOT_VERIFIED');
    expect(result.candidates[0]?.status).toBe('DISCOVERED');
  });
});
