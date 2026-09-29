import { ConflictEngineService } from './conflict/conflict-engine.service';
import { independentSourceKey, registrableDomain, countIndependentSources } from './utils/source-independence';
import { assessPersonEmailOwnership } from './utils/email-ownership';
import { summarizeAggregateVerification } from './utils/aggregate-verification';
import { assessPersonCompanyRelationship, publicHitEstablishesRelationship } from '../contacts/discovery/person-company-relationship';
import { assessPublicDecisionMaker, isCompanyProfileUrl, isPersonProfileUrl } from '../contacts/discovery/public-decision-maker';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import { discoveryAcceptanceCap, discoveryTarget, latestScorePassesFilter, resolveCountIntent } from '../search/search-plan.limits';
import { SearchPlanParser } from '../search/parsers/search-plan.parser';
import { EmailVerificationProvider } from './providers/email/email-verification.provider';
import { SocialVerificationProvider } from './providers/social/social-verification.provider';
import type { VerificationEvidence } from './types/verification.types';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { applyExportMode } from '../exports/export-mode';

function claimEvidence(field: string, value: string, sourceUrl: string, provider: string, evidenceText?: string): VerificationEvidence {
  return {
    id: `${provider}-${field}-${sourceUrl}`,
    sourceUrl,
    canonicalUrl: sourceUrl,
    evidenceType: 'COMPANY_WEBSITE',
    evidenceText: evidenceText ?? value,
    metadata: { field, value },
    retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
    provider,
    sourceType: provider,
  };
}

function baseContext(overrides: Partial<QualificationContext> = {}): QualificationContext {
  return {
    company: {
      id: 'company-1',
      name: 'Northwind Software',
      website: 'https://northwind.example',
      email: null,
      phone: null,
      description: 'Northwind builds software platforms for enterprises.',
      category: 'software',
      investorType: null,
      employeeCount: 37,
      employeeRange: '11-50',
      verificationStatus: 'SUPPORTED',
    },
    socialProfiles: [
      { platform: 'linkedin', profileUrl: 'https://linkedin.com/company/northwind' },
      { platform: 'facebook', profileUrl: 'https://facebook.com/northwind' },
      { platform: 'instagram', profileUrl: 'https://instagram.com/northwind' },
    ],
    location: { city: 'San Francisco', state: 'California', country: 'US', postalCode: null },
    contacts: [{
      id: 'contact-1',
      fullName: 'Ada Founder',
      title: 'CEO',
      normalizedRole: 'CEO',
      companyRelationship: 'Northwind Software',
      email: 'ada@northwind.example',
      phone: null,
      linkedinUrl: 'https://linkedin.com/in/ada-founder',
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      verificationStatus: 'SUPPORTED',
    }],
    evidence: [{
      id: 'ev-1',
      evidenceType: 'COMPANY_WEBSITE',
      sourceUrl: 'https://northwind.example/team',
      evidenceText: 'Ada Founder is CEO of Northwind Software.',
      provider: 'official_website',
      sourceType: 'WEBSITE',
      retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: { field: 'companyRelationship', value: 'Northwind Software' },
    }],
    verifications: [
      { field: 'companyName', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
      { field: 'website', status: 'SUPPORTED', fieldValue: 'https://northwind.example', evidenceId: 'ev-1' },
      { field: 'state', status: 'VERIFIED', fieldValue: 'California', evidenceId: 'ev-1' },
      { field: 'fullName', status: 'SUPPORTED', fieldValue: 'Ada Founder', evidenceId: 'ev-1' },
      { field: 'title', status: 'SUPPORTED', fieldValue: 'CEO', evidenceId: 'ev-1' },
      { field: 'companyRelationship', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
      {
        field: 'email',
        status: 'VERIFIED',
        fieldValue: 'ada@northwind.example',
        evidenceId: 'ev-1',
        metadata: { ownershipVerified: true, verificationKind: 'ownership', ownershipSourceCount: 2 },
      },
      { field: 'linkedin', status: 'SUPPORTED', fieldValue: 'https://linkedin.com/in/ada-founder', evidenceId: 'ev-1' },
    ],
    conflicts: [],
    classification: null,
    score: { value: 92, band: 'VERY_HIGH', breakdown: {} as never },
    ...overrides,
  };
}

const verifiedPersonPlan = {
  industry: ['software'],
  leadTypes: [] as string[],
  locations: [{ country: 'US', state: 'California' }],
  companySize: { min: 1, max: 50 },
  companyFields: ['website', 'linkedin'],
  personFields: ['linkedin', 'email'],
  socialPlatforms: ['linkedin'],
  decisionMakerRoles: ['CEO'],
  requiredRoles: ['CEO'],
  requiredFields: ['website', 'companyLinkedin', 'personLinkedin', 'personEmail'],
  emailRequirement: { requested: true, required: true, verified: true },
  websiteRequirement: { requested: true, required: true },
  verificationRequirement: { requested: true, required: true, fields: ['email'] },
  unresolvedCriteria: [] as Array<{ text: string; reason: string }>,
};

describe('Phase H evidence independence, relationship, and aggregate verification', () => {
  const engine = new ConflictEngineService();
  const parser = new SearchPlanParser();

  it('A: same-domain pages are one evidence source', () => {
    expect(registrableDomain('https://example.com/about')).toBe('example.com');
    expect(registrableDomain('https://example.com/team')).toBe('example.com');
    expect(independentSourceKey({ provider: 'website', sourceUrl: 'https://example.com/about' }))
      .toBe(independentSourceKey({ provider: 'web_search', sourceUrl: 'https://www.example.com/contact' }));
    const result = engine.evaluateField({
      field: 'email',
      value: 'ada@example.com',
      evidence: [
        claimEvidence('email', 'ada@example.com', 'https://example.com/about', 'website'),
        claimEvidence('email', 'ada@example.com', 'https://example.com/team', 'website'),
        claimEvidence('email', 'ada@example.com', 'https://www.example.com/contact', 'website'),
      ],
    }, () => 1);
    expect(result.status).toBe('SUPPORTED');
    expect(result.metadata?.sourceCount).toBe(1);
  });

  it('B: different independent domains can count separately', () => {
    expect(countIndependentSources([
      { sourceUrl: 'https://northwind.example/team', provider: 'website' },
      { sourceUrl: 'https://news.example/article', provider: 'web_search' },
    ])).toBe(2);
    expect(registrableDomain('https://acme.co.uk/about')).toBe('acme.co.uk');
    expect(registrableDomain('https://acme.com.au/team')).toBe('acme.com.au');
  });

  it('C: same website through different providers does not inflate independence', () => {
    expect(independentSourceKey({ provider: 'official_website', sourceUrl: 'https://oak.example/team' }))
      .toBe(independentSourceKey({ provider: 'tavily', sourceUrl: 'https://oak.example/about' }));
    const result = engine.evaluateField({
      field: 'title',
      value: 'CEO',
      evidence: [
        claimEvidence('title', 'CEO', 'https://oak.example/team', 'official_website'),
        claimEvidence('title', 'CEO', 'https://oak.example/about', 'web_search'),
      ],
    }, () => 1);
    expect(result.metadata?.sourceCount).toBe(1);
    expect(result.status).toBe('SUPPORTED');
  });

  it('D: person on official company team page can establish relationship', () => {
    const hit = {
      title: 'Leadership | Northwind Software',
      url: 'https://northwind.example/team',
      snippet: 'Ada Lovelace is CEO of Northwind Software.',
    };
    expect(publicHitEstablishesRelationship('Northwind Software', hit, 'Ada Lovelace', 'CEO', 'https://northwind.example')).toBe(true);
    const candidate = assessPublicDecisionMaker('Northwind Software', hit, {
      allowedRoles: ['CEO'],
      companyWebsite: 'https://northwind.example',
    });
    expect(candidate?.fullName).toBe('Ada Lovelace');
    const relationship = assessPersonCompanyRelationship({
      personName: 'Ada Lovelace',
      title: 'CEO',
      companyName: 'Northwind Software',
      companyWebsite: 'https://northwind.example',
      evidence: [{ sourceUrl: hit.url, evidenceText: hit.snippet }],
    });
    expect(relationship.verdict).toBe('STRONG');
    expect(relationship.freshnessClaimed).toBe(false);
  });

  it('E: random snippet does not establish strong relationship', () => {
    expect(assessPublicDecisionMaker('Northwind Software', {
      title: 'Top CEOs to watch',
      url: 'https://random-listicle.example/ceos',
      snippet: 'Ada Founder, CEO. Industry leaders gathered in San Francisco.',
    }, { allowedRoles: ['CEO'], companyWebsite: 'https://northwind.example' })).toBeNull();

    const weak = assessPersonCompanyRelationship({
      personName: 'Ada Founder',
      title: 'CEO',
      companyName: 'Northwind Software',
      companyWebsite: 'https://northwind.example',
      companyRelationship: 'current',
      evidence: [{
        sourceUrl: 'https://random-listicle.example/ceos',
        evidenceText: 'Ada Founder, CEO. Sponsors include Northwind Software.',
      }],
    });
    expect(['WEAK', 'AMBIGUOUS', 'MISSING']).toContain(weak.verdict);
    expect(weak.verdict).not.toBe('STRONG');
  });

  it('F: wrong-company person is rejected', () => {
    expect(assessPublicDecisionMaker('Northwind Software', {
      title: 'Ada Founder, CEO of Contoso Capital',
      url: 'https://linkedin.com/in/ada-founder',
      snippet: 'Ada Founder is CEO of Contoso Capital.',
    }, { allowedRoles: ['CEO'] })).toBeNull();

    const rejected = assessPersonCompanyRelationship({
      personName: 'Ada Founder',
      title: 'CEO',
      companyName: 'Northwind Software',
      evidence: [{
        sourceUrl: 'https://news.example/x',
        evidenceText: 'Ada Founder is CEO of Contoso Capital.',
      }],
    });
    expect(rejected.verdict).toBe('REJECTED');
  });

  it('G: person email without ownership stays NEEDS_REVIEW for verified-person-email', () => {
    const criteria = normalizeCriteria(verifiedPersonPlan);
    const decision = evaluateQualification(baseContext({
      verifications: baseContext().verifications.map((item) => item.field === 'email'
        ? { ...item, status: 'SUPPORTED', metadata: { ownershipVerified: false, verificationKind: 'evidence_supported' } }
        : item),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('H: ZeroBounce deliverability does not equal ownership', async () => {
    const outbound = {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'valid', sub_status: '' }) }),
    };
    const provider = new EmailVerificationProvider(
      { get: (key: string) => (key === 'verification.zeroBounceApiKey' ? 'zb-key' : key === 'verification.zeroBounceBaseUrl' ? 'https://api.zerobounce.net/v2' : 10000) } as ConfigService,
      outbound as never,
    );
    const result = await provider.verify({ field: 'email', value: 'ada@northwind.example', evidence: [] });
    expect(result.metadata?.deliverabilityVerified).toBe(true);
    expect(result.metadata?.ownershipVerified).toBe(false);
    const ownership = assessPersonEmailOwnership({
      email: 'ada@northwind.example',
      personName: 'Ada Founder',
      evidence: [],
      deliverabilityVerified: true,
    });
    expect(ownership.ownershipVerified).toBe(false);
    expect(ownership.verificationKind).toBe('deliverability');
  });

  it('I: company social cannot satisfy person social', () => {
    expect(isCompanyProfileUrl('https://linkedin.com/company/northwind')).toBe(true);
    const criteria = normalizeCriteria(verifiedPersonPlan);
    const decision = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], linkedinUrl: 'https://linkedin.com/company/northwind' }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');
  });

  it('J: person LinkedIn cannot satisfy company social', async () => {
    expect(isPersonProfileUrl('https://linkedin.com/in/ada-founder')).toBe(true);
    const social = await new SocialVerificationProvider().verify({
      field: 'companyLinkedin',
      value: 'https://linkedin.com/in/ada-founder',
      evidence: [],
    });
    expect(social.status).toBe('INVALID');
    const criteria = normalizeCriteria(verifiedPersonPlan);
    const decision = evaluateQualification(baseContext({
      socialProfiles: [{ platform: 'linkedin', profileUrl: 'https://linkedin.com/in/ada-founder' }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'companySocial:linkedin')?.result).toBe('NOT_FOUND');
  });

  it('K: aggregate verification status is truthful', () => {
    const deliverabilityOnly = summarizeAggregateVerification([
      { field: 'website', status: 'SUPPORTED' },
      { field: 'email', status: 'VERIFIED', metadata: { deliverabilityVerified: true, ownershipVerified: false, verificationKind: 'deliverability' } },
    ]);
    expect(deliverabilityOnly.aggregateStatus).not.toBe('VERIFIED');
    expect(deliverabilityOnly.flags.deliverabilityVerified).toBe(true);
    expect(deliverabilityOnly.flags.personOwnershipVerified).toBe(false);
    expect(deliverabilityOnly.fields.find((item) => item.field === 'email')?.displayStatus).toBe('DELIVERABILITY_VERIFIED');

    const ownership = summarizeAggregateVerification([
      { field: 'email', status: 'VERIFIED', metadata: { ownershipVerified: true, verificationKind: 'ownership' } },
      { field: 'website', status: 'SUPPORTED' },
    ]);
    expect(ownership.flags.personOwnershipVerified).toBe(true);
    expect(ownership.fields.find((item) => item.field === 'email')?.displayStatus).toBe('PERSON_OWNERSHIP_VERIFIED');
  });

  it('L: qualification remains blocked by critical missing evidence', () => {
    const criteria = normalizeCriteria(verifiedPersonPlan);
    const decision = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], linkedinUrl: null }],
    }), criteria);
    expect(decision.status).not.toBe('QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');
  });

  it('M: high score cannot override failed factual requirements', () => {
    const criteria = normalizeCriteria({ ...verifiedPersonPlan, minimumScore: 80 });
    const decision = evaluateQualification(baseContext({
      score: { value: 99, band: 'VERY_HIGH', breakdown: {} as never },
      company: { ...baseContext().company, employeeCount: 200 },
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('N: minScore + QUALIFIED filtering still works', () => {
    expect(latestScorePassesFilter([
      { score: 60, calculatedAt: '2026-01-01T00:00:00.000Z' },
      { score: 91, calculatedAt: '2026-03-01T00:00:00.000Z' },
    ], { minScore: 80 })).toBe(true);
    const filters = applyExportMode(plainToInstance(ListLeadsDto, { qualificationStatus: 'QUALIFIED', minScore: '80' }), 'QUALIFIED');
    expect(filters.qualificationStatus).toBe('QUALIFIED');
    expect(filters.minScore).toBe(80);
  });

  it('O: Phase F ownership behavior remains intact', () => {
    const ownership = assessPersonEmailOwnership({
      email: 'ada@northwind.example',
      personName: 'Ada Founder',
      evidence: [
        claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'Ada Founder — ada@northwind.example'),
        claimEvidence('email', 'ada@northwind.example', 'https://news.example/p', 'web_search', 'Ada Founder contact ada@northwind.example'),
      ],
      evidenceStatus: 'VERIFIED',
    });
    expect(ownership.ownershipVerified).toBe(true);
    expect(assessPersonEmailOwnership({
      email: 'info@northwind.example',
      personName: 'Ada Founder',
      evidence: [
        claimEvidence('email', 'info@northwind.example', 'https://a.example', 'website', 'Ada Founder info@northwind.example'),
        claimEvidence('email', 'info@northwind.example', 'https://b.example', 'web', 'Ada Founder info@northwind.example'),
      ],
    }).ownershipVerified).toBe(false);
  });

  it('P: Phase G exclusions remain intact', () => {
    const plan = parser.parse('Find software companies in California excluding agencies');
    expect(plan.exclusions?.some((item) => /agenc/i.test(item))).toBe(true);
    const criteria = normalizeCriteria({ ...verifiedPersonPlan, exclusions: ['agencies'] });
    const decision = evaluateQualification(baseContext({
      company: {
        ...baseContext().company,
        name: 'Bright Marketing Agency',
        description: 'We are a digital marketing agency.',
      },
      evidence: [{ ...baseContext().evidence[0], evidenceText: 'Bright Marketing Agency is a full-service agency.' }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'exclusion')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('Q: Phase G countIntent behavior remains intact', () => {
    const exact = parser.parse('Find 50 software companies in California');
    expect(resolveCountIntent(exact)).toBe('exact');
    expect(discoveryTarget(exact)).toBe(50);
    expect(discoveryAcceptanceCap(exact)).toBe(50);
    const minimum = parser.parse('Find at least 50 software companies in California');
    expect(resolveCountIntent(minimum)).toBe('minimum');
    expect(discoveryTarget(minimum)).toBeGreaterThan(50);
  });

  it('qualified path still works with relationship + ownership evidence', () => {
    const criteria = normalizeCriteria(verifiedPersonPlan);
    expect(evaluateQualification(baseContext(), criteria).status).toBe('QUALIFIED');
  });
});
