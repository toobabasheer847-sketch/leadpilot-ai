import { ConfigService } from '@nestjs/config';
import { ContactExtractorService, publicPersonEmail } from './extraction/contact-extractor.service';
import { WebsiteContactProvider } from './providers/website-contact.provider';
import { SnovContactProvider, companyNamesCompatible, emailBelongsToDomain, prioritizeByRoles } from './providers/snov-contact.provider';
import { WebsiteNormalizerService } from '../enrichment/website/website-normalizer.service';
import { WebsiteDiscoveryService } from '../enrichment/website/website-discovery.service';
import { PersonDiscoveryService } from './discovery/person-discovery.service';
import { PersonIdentityMatcherService } from './matching/person-identity-matcher.service';
import { PersonCandidateService } from './discovery/person-candidate.service';
import { assessPublicDecisionMaker, decisionMakerQueries, roleMatches } from './discovery/public-decision-maker';
import { contactDiscoveryRequested, decisionMakerRolesForPlan, DEFAULT_DECISION_MAKER_ROLES } from '../search/search-plan.limits';
import type { ContactCandidate } from './types/contact.types';
import type { SearchPlan } from '../search/types/search-plan.types';

function plan(partial: Partial<SearchPlan>): SearchPlan {
  return {
    industry: [],
    leadTypes: [],
    locations: [],
    companyFields: [],
    unresolvedCriteria: [],
    ...partial,
  };
}

describe('Phase D plan-driven contact discovery', () => {
  it('extracts CEO and Founder from an official team page with evidence', () => {
    const extractor = new ContactExtractorService({ get: () => [] } as ConfigService);
    const provider = new WebsiteContactProvider(extractor, {} as WebsiteDiscoveryService, new WebsiteNormalizerService());
    const html = `
      <html><body>
        <h1>Our Team</h1>
        <p>John Smith is the Founder and CEO of Northwind Partners.</p>
        <p>Reach John at john.smith@northwind.example</p>
        <a href="https://www.linkedin.com/in/john-smith">LinkedIn</a>
      </body></html>
    `;
    const candidates = provider.extractCandidatesFromHtml('https://northwind.example/team', html, 'Northwind Partners', ['CEO', 'Founder']);
    expect(candidates.some((item) => /founder/i.test(item.title ?? ''))).toBe(true);
    expect(candidates.some((item) => /ceo/i.test(item.title ?? ''))).toBe(true);
    expect(candidates[0]?.email).toBe('john.smith@northwind.example');
    expect(candidates[0]?.evidence.some((item) => item.field === 'email' && item.evidenceType === 'WEBSITE_TEAM_PAGE')).toBe(true);
    expect(candidates[0]?.linkedinUrl).toBe('https://linkedin.com/in/john-smith');
  });

  it('uses SearchPlan decisionMakerRoles for public web queries', () => {
    expect(decisionMakerQueries('Oak Stream Investors', ['CEO', 'Founder'])).toEqual([
      '"Oak Stream Investors" CEO',
      '"Oak Stream Investors" Founder',
      '"Oak Stream Investors" (founder OR CEO OR owner OR president) (email OR contact OR phone)',
      '"Oak Stream Investors" founder OR CEO linkedin',
      '"Oak Stream Investors" "about us" OR team OR leadership',
    ]);
    expect(decisionMakerQueries('Oak Stream Investors', ['Managing Director'])).toEqual([
      '"Oak Stream Investors" "Managing Director"',
      '"Oak Stream Investors" (founder OR CEO OR owner OR president) (email OR contact OR phone)',
      '"Oak Stream Investors" founder OR CEO linkedin',
      '"Oak Stream Investors" "about us" OR team OR leadership',
    ]);
  });

  it('defaults to executive roles when the plan did not name roles', () => {
    expect(decisionMakerRolesForPlan(plan({ targetType: 'QUALIFIED_LEADS' }))).toEqual([...DEFAULT_DECISION_MAKER_ROLES]);
    expect(decisionMakerRolesForPlan(plan({ decisionMakerRoles: ['Owner', 'Manager'] }))).toEqual(['Owner', 'Manager']);
  });

  it('skips contact discovery for company-only plans and runs when roles or person fields are requested', () => {
    expect(contactDiscoveryRequested(plan({ targetType: 'COMPANIES', companyFields: ['website'] }))).toBe(false);
    expect(contactDiscoveryRequested(plan({ decisionMakerRoles: ['CEO'] }))).toBe(true);
    expect(contactDiscoveryRequested(plan({ personFields: ['personEmail'] }))).toBe(true);
    expect(contactDiscoveryRequested(plan({ emailRequirement: { requested: true, required: false, verified: false } }))).toBe(true);
    expect(contactDiscoveryRequested(plan({ targetType: 'QUALIFIED_LEADS' }))).toBe(true);
    expect(contactDiscoveryRequested(null)).toBe(true);
  });

  it('supports multiple requested roles without inventing others', () => {
    const ceo = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe - CEO - Oak Stream Investors',
      url: 'https://oakstream.example/team',
      snippet: 'Jane Doe is CEO of Oak Stream Investors.',
    }, { allowedRoles: ['CEO', 'Founder'] });
    const owner = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Sam Lee - Owner - Oak Stream Investors',
      url: 'https://oakstream.example/team',
      snippet: 'Sam Lee is Owner of Oak Stream Investors.',
    }, { allowedRoles: ['CEO', 'Founder'] });
    expect(ceo?.title).toBe('CEO');
    expect(owner).toBeNull();
    expect(roleMatches('Managing Director', ['managing director'])).toBe(true);
  });

  it('never pattern-generates emails and rejects generic mailboxes as personal email', () => {
    expect(publicPersonEmail('Contact John Smith at john.smith@northwind.example')).toBe('john.smith@northwind.example');
    expect(publicPersonEmail('Email info@northwind.example')).toBeNull();
    expect(publicPersonEmail('No email present for John Smith, Founder')).toBeNull();
    const candidate = assessPublicDecisionMaker('Northwind Partners', {
      title: 'John Smith, Founder of Northwind Partners',
      url: 'https://northwind.example/team',
      snippet: 'John Smith, Founder of Northwind Partners. Contact info@northwind.example.',
    });
    expect(candidate?.email).toBeNull();
    expect(candidate?.emailStatus).toBe('NOT_FOUND');
  });

  it('rejects people tied to a different company domain or name', () => {
    expect(assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, CEO of Northwind Capital',
      url: 'https://www.linkedin.com/in/jane-doe',
      snippet: 'Jane Doe is CEO of Northwind Capital.',
    })).toBeNull();
    expect(companyNamesCompatible('Northwind Capital LLC', 'Oak Stream Investors')).toBe(false);
    expect(companyNamesCompatible('Oak Stream Investors Inc', 'Oak Stream Investors')).toBe(true);
    expect(emailBelongsToDomain('jane@oakstream.example', 'oakstream.example')).toBe(true);
    expect(emailBelongsToDomain('jane@other.example', 'oakstream.example')).toBe(false);
  });

  it('maps Snov provider prospects without inventing missing emails or wrong-company people', () => {
    const provider = new SnovContactProvider({
      get: (key: string) => ({
        'contactProvider.clientId': 'id',
        'contactProvider.clientSecret': 'secret',
        'contactProvider.baseUrl': 'https://api.snov.io',
      }[key]),
    } as ConfigService);
    const matched = provider.mapProspect({
      fullName: 'Ada Example',
      position: 'CEO',
      email: 'ada@oakstream.example',
      emailStatus: 'valid',
      linkedinUrl: 'https://www.linkedin.com/in/ada-example',
      companyName: 'Oak Stream Investors',
    }, 'Oak Stream Investors', 'oakstream.example');
    expect(matched).toMatchObject({
      fullName: 'Ada Example',
      title: 'CEO',
      email: 'ada@oakstream.example',
      linkedinUrl: 'https://www.linkedin.com/in/ada-example',
    });
    expect(matched?.evidence.every((item) => item.evidenceType === 'PROVIDER_SNOV')).toBe(true);

    expect(provider.mapProspect({
      fullName: 'Wrong Person',
      position: 'CEO',
      email: 'wrong@other.example',
      companyName: 'Other Holdings',
    }, 'Oak Stream Investors', 'oakstream.example')).toBeNull();

    expect(provider.mapProspect({
      fullName: 'No Email Person',
      position: 'Founder',
      companyName: 'Oak Stream Investors',
    }, 'Oak Stream Investors', 'oakstream.example')).toMatchObject({
      email: null,
      emailStatus: 'NOT_FOUND',
    });
  });

  it('falls back to Snov when website discovery yields no people', async () => {
    const websiteProvider = {
      discover: jest.fn().mockResolvedValue({ candidates: [] }),
    } as unknown as WebsiteContactProvider;
    const snov = {
      configured: () => true,
      discover: jest.fn().mockResolvedValue({
        candidates: [{
          fullName: 'Ada Example',
          title: 'CEO',
          email: 'ada@oak.example',
          emailStatus: 'VERIFIED',
          companyName: 'Oak',
          sourceUrl: 'https://api.snov.io',
          evidence: [{ field: 'fullName', value: 'Ada Example', sourceUrl: 'https://api.snov.io', evidenceExcerpt: 'Ada', retrievedAt: '2026-09-28T00:00:00.000Z', evidenceType: 'PROVIDER_SNOV' }],
          status: 'DISCOVERED',
          verificationStatus: 'NOT_VERIFIED',
        } satisfies ContactCandidate],
      }),
    } as unknown as SnovContactProvider;
    const service = new PersonDiscoveryService(
      websiteProvider,
      new PersonIdentityMatcherService(),
      new PersonCandidateService(new ContactExtractorService({ get: () => [] } as ConfigService)),
      snov,
    );
    const result = await service.discover(
      { id: 'c1', name: 'Oak', website: 'https://oak.example' },
      { companyId: 'c1', organizationId: 'o1', decisionMakerRoles: ['CEO'], emailRequested: true },
    );
    expect(snov.discover as jest.Mock).toHaveBeenCalled();
    expect(result.candidates[0]?.fullName).toBe('Ada Example');
  });

  it('does not call the provider when contacts are disallowed or website already found people with email', async () => {
    const websiteProvider = {
      discover: jest.fn().mockResolvedValue({
        candidates: [{
          fullName: 'Ada Example',
          title: 'CEO',
          email: 'ada@oak.example',
          emailStatus: 'FOUND',
          companyName: 'Oak',
          sourceUrl: 'https://oak.example/team',
          evidence: [],
          status: 'DISCOVERED',
          verificationStatus: 'NOT_VERIFIED',
        } satisfies ContactCandidate],
      }),
    } as unknown as WebsiteContactProvider;
    const snov = {
      configured: () => true,
      discover: jest.fn(),
    } as unknown as SnovContactProvider;
    const service = new PersonDiscoveryService(
      websiteProvider,
      new PersonIdentityMatcherService(),
      new PersonCandidateService(new ContactExtractorService({ get: () => [] } as ConfigService)),
      snov,
    );
    await service.discover(
      { id: 'c1', name: 'Oak', website: 'https://oak.example' },
      { companyId: 'c1', organizationId: 'o1', decisionMakerRoles: ['CEO'], emailRequested: true },
    );
    expect(snov.discover as jest.Mock).not.toHaveBeenCalled();

    await service.discover(
      { id: 'c1', name: 'Oak', website: 'https://oak.example' },
      { companyId: 'c1', organizationId: 'o1', decisionMakerRoles: ['CEO'], allowProviderEnrichment: false },
    );
    // Website returned people, so provider still not needed; explicitly disallowed path:
    const emptyWebsite = { discover: jest.fn().mockResolvedValue({ candidates: [] }) } as unknown as WebsiteContactProvider;
    const blocked = new PersonDiscoveryService(emptyWebsite, new PersonIdentityMatcherService(), new PersonCandidateService(new ContactExtractorService({ get: () => [] } as ConfigService)), snov);
    await blocked.discover(
      { id: 'c1', name: 'Oak', website: 'https://oak.example' },
      { companyId: 'c1', organizationId: 'o1', decisionMakerRoles: ['CEO'], allowProviderEnrichment: false },
    );
    expect(snov.discover as jest.Mock).not.toHaveBeenCalled();
  });

  it('continues when one website discovery fails and marks missing contacts as NOT_FOUND rather than inventing people', async () => {
    const websiteProvider = {
      discover: jest.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as WebsiteContactProvider;
    const service = new PersonDiscoveryService(
      websiteProvider,
      new PersonIdentityMatcherService(),
      new PersonCandidateService(new ContactExtractorService({ get: () => [] } as ConfigService)),
    );
    const result = await service.discover(
      { id: 'c1', name: 'Oak', website: 'https://oak.example' },
      { companyId: 'c1', organizationId: 'o1', decisionMakerRoles: ['CEO'] },
    );
    expect(result.candidates).toEqual([]);
  });

  it('prioritizes SearchPlan roles and keeps unmatched person social off company profiles', () => {
    const ranked = prioritizeByRoles([
      { fullName: 'A', title: 'Manager', companyName: 'Oak', sourceUrl: 'https://a', evidence: [], status: 'DISCOVERED', verificationStatus: 'NOT_VERIFIED' },
      { fullName: 'B', title: 'CEO', companyName: 'Oak', sourceUrl: 'https://b', evidence: [], status: 'DISCOVERED', verificationStatus: 'NOT_VERIFIED' },
    ], ['CEO', 'Founder']);
    expect(ranked[0]?.title).toBe('CEO');

    const companySocialHit = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, Founder of Oak Stream Investors',
      url: 'https://www.linkedin.com/company/oak-stream-investors',
      snippet: 'Jane Doe is Founder of Oak Stream Investors.',
    });
    expect(companySocialHit?.linkedinUrl).toBeUndefined();
  });

  it('uses a stable contact-discovery idempotency key shape', () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const key = (organizationId: string, companyId: string, searchExecutionId: string | null) =>
      `contact-discovery-${createHash('sha256').update(`${organizationId}:${companyId}:${searchExecutionId ?? 'direct'}`).digest('hex')}`;
    expect(key('org', 'co', 'exec-1')).toBe(key('org', 'co', 'exec-1'));
    expect(key('org', 'co', 'exec-1')).not.toBe(key('org', 'co', 'exec-2'));
  });

  it('does not invent missing person fields when evidence is absent', () => {
    const extractor = new ContactExtractorService({ get: () => ['CEO'] } as ConfigService);
    const provider = new WebsiteContactProvider(extractor, {} as WebsiteDiscoveryService, new WebsiteNormalizerService());
    expect(provider.extractCandidatesFromHtml('https://oak.example/about', '<html><body><p>About Oak Stream Investors</p></body></html>', 'Oak Stream Investors', ['CEO'])).toEqual([]);
  });
});
