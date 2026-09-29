import { plainToInstance } from 'class-transformer';
import { SearchPlanParser } from '../search/parsers/search-plan.parser';
import {
  countShortfall,
  discoveryAcceptanceCap,
  discoveryTarget,
  explicitResultCount,
  latestScorePassesFilter,
  qualifiedShortfall,
  resolveCountIntent,
} from '../search/search-plan.limits';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import { applyExportMode } from '../exports/export-mode';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { assessPersonEmailOwnership } from '../verification/utils/email-ownership';
import { assessPersonCompanyRelationship } from '../contacts/discovery/person-company-relationship';
import { isCompanyProfileUrl, isPersonProfileUrl } from '../contacts/discovery/public-decision-maker';
import { emptyCounters, maskCounters } from '../pipeline/pipeline.progress';
import type { StageMap } from '../pipeline/pipeline.types';

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
      fullName: 'Ada Lovelace',
      title: 'CEO',
      normalizedRole: 'CEO',
      companyRelationship: 'current',
      email: 'ada@northwind.example',
      phone: null,
      linkedinUrl: 'https://linkedin.com/in/ada-lovelace',
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      verificationStatus: 'SUPPORTED',
    }],
    evidence: [{
      id: 'ev-1',
      evidenceType: 'COMPANY_WEBSITE',
      sourceUrl: 'https://northwind.example/about',
      evidenceText: 'Northwind builds software platforms for enterprises. Ada Lovelace is CEO.',
      provider: 'official_website',
      sourceType: 'WEBSITE',
      retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: {},
    }],
    verifications: [
      { field: 'companyName', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
      { field: 'website', status: 'SUPPORTED', fieldValue: 'https://northwind.example', evidenceId: 'ev-1' },
      { field: 'state', status: 'VERIFIED', fieldValue: 'California', evidenceId: 'ev-1' },
      { field: 'fullName', status: 'SUPPORTED', fieldValue: 'Ada Lovelace', evidenceId: 'ev-1' },
      { field: 'title', status: 'SUPPORTED', fieldValue: 'CEO', evidenceId: 'ev-1' },
      { field: 'companyRelationship', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
      {
        field: 'email',
        status: 'VERIFIED',
        fieldValue: 'ada@northwind.example',
        evidenceId: 'ev-1',
        metadata: { ownershipVerified: true, verificationKind: 'ownership', ownershipSourceCount: 2 },
      },
      { field: 'linkedin', status: 'SUPPORTED', fieldValue: 'https://linkedin.com/in/ada-lovelace', evidenceId: 'ev-1' },
    ],
    conflicts: [],
    classification: null,
    score: { value: 92, band: 'VERY_HIGH', breakdown: {} as never },
    ...overrides,
  };
}

const richRequiredPlan = {
  industry: ['software'],
  leadTypes: [] as string[],
  locations: [{ country: 'US', state: 'California' }],
  companySize: { min: 1, max: 50 },
  companyFields: ['website', 'linkedin', 'facebook', 'instagram'],
  personFields: ['linkedin', 'email'],
  socialPlatforms: ['linkedin', 'facebook', 'instagram'],
  decisionMakerRoles: ['CEO', 'Founder'],
  requiredRoles: ['CEO', 'Founder'],
  requiredFields: ['website', 'companyLinkedin', 'companyFacebook', 'companyInstagram', 'personLinkedin', 'personEmail'],
  emailRequirement: { requested: true, required: true, verified: true },
  websiteRequirement: { requested: true, required: true },
  verificationRequirement: { requested: true, required: true, fields: ['email'] },
  requestedCount: 100,
  countIntent: 'exact' as const,
  minimumScore: 80,
  unresolvedCriteria: [] as Array<{ text: string; reason: string }>,
};

const completedStages: StageMap = {
  search: 'COMPLETED',
  sourceDiscovery: 'COMPLETED',
  companyPersistence: 'COMPLETED',
  websiteDiscovery: 'COMPLETED',
  enrichment: 'COMPLETED',
  deepResearch: 'COMPLETED',
  employeeSize: 'COMPLETED',
  decisionMakerDiscovery: 'COMPLETED',
  contactQuality: 'COMPLETED',
  evidence: 'COMPLETED',
  classification: 'COMPLETED',
  verification: 'COMPLETED',
  deduplication: 'COMPLETED',
  scoring: 'COMPLETED',
  qualification: 'COMPLETED',
};

describe('Phase I search intent, count semantics, and qualification traceability', () => {
  const parser = new SearchPlanParser();

  it('A: exact count — Find exactly 50 → target/cap 50, shortfall when fewer', () => {
    const plan = parser.parse('Find exactly 50 software companies in California');
    expect(plan.requestedCount).toBe(50);
    expect(plan.countIntent).toBe('exact');
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryTarget(plan)).toBe(50);
    expect(discoveryAcceptanceCap(plan)).toBe(50);
    expect(countShortfall(plan, 40)).toBe(10);
    expect(countShortfall(plan, 50)).toBe(0);
    expect(countShortfall(plan, 60)).toBe(0); // acceptance cap prevents intentional overshoot; shortfall uses requested
  });

  it('B: maximum count — Find up to 50 → never intentionally accept >50', () => {
    const plan = parser.parse('Find up to 50 software companies in California');
    expect(plan.countIntent).toBe('maximum');
    expect(discoveryTarget(plan)).toBe(50);
    expect(discoveryAcceptanceCap(plan)).toBe(50);
    expect(countShortfall(plan, 40)).toBe(10);
  });

  it('C: minimum count — Find at least 50 → over-seek + honest shortfall', () => {
    const plan = parser.parse('Find at least 50 software companies in California');
    expect(plan.countIntent).toBe('minimum');
    expect(discoveryTarget(plan)).toBe(Math.ceil(50 * 1.25));
    expect(discoveryAcceptanceCap(plan)).toBeGreaterThan(50);
    expect(countShortfall(plan, 40)).toBe(10);
    expect(countShortfall(plan, 60)).toBe(0);
  });

  it('D: approximate count — Find around 50 → approximate preserved (not silently exact)', () => {
    const plan = parser.parse('Find around 50 software companies in California');
    expect(plan.countIntent).toBe('approximate');
    expect(plan.requestedCount).toBe(50);
    expect(resolveCountIntent(plan)).toBe('approximate');
    expect(discoveryTarget(plan)).toBe(50);
    expect(discoveryAcceptanceCap(plan)).toBe(50);
  });

  it('E: requested vs qualified remain distinct metrics', () => {
    const plan = { requestedCount: 100, countIntent: 'exact' as const, maxResults: 100 };
    expect(explicitResultCount(plan)).toBe(100);
    expect(qualifiedShortfall(plan, 63)).toBe(37);
    expect(countShortfall(plan, 80)).toBe(20);
    // Requested N is never rewritten as qualified N.
    expect(qualifiedShortfall(plan, 63)).not.toBe(0);
    expect(63).not.toBe(100);

    const counters = maskCounters(completedStages, {
      ...emptyCounters(),
      requestedCount: 100,
      countIntent: 'exact',
      companiesDiscovered: 90,
      companiesPersisted: 80,
      discoveryShortfall: 20,
      qualifiedLeads: 63,
      qualifiedShortfall: 37,
      needsReview: 10,
      rejected: 7,
    });
    expect(counters.requestedCount).toBe(100);
    expect(counters.countIntent).toBe('exact');
    expect(counters.companiesPersisted).toBe(80);
    expect(counters.qualifiedLeads).toBe(63);
    expect(counters.qualifiedShortfall).toBe(37);
    expect(counters.discoveryShortfall).toBe(20);
  });

  it('F: qualification criterionResults map to SearchPlan criteria', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    expect(criteria.requestedCount).toBe(100);
    expect(criteria.countIntent).toBe('exact');
    expect(criteria.locations.some((item) => item.state === 'California')).toBe(true);
    expect(criteria.industry).toEqual(expect.arrayContaining(['software']));
    expect(criteria.companySize).toMatchObject({ min: 1, max: 50 });
    expect(criteria.requiredRoles).toEqual(expect.arrayContaining(['CEO', 'Founder']));
    expect(criteria.personEmailRequired).toBe(true);
    expect(criteria.verifiedEmailRequired).toBe(true);
    expect(criteria.minimumScore).toBe(80);
    expect(criteria.personRequiredFields).toEqual(expect.arrayContaining(['personLinkedin', 'personEmail']));

    const decision = evaluateQualification(baseContext(), criteria);
    const by = (name: string) => decision.criterionResults.find((item) => item.criterion === name);
    expect(by('location')?.result).toBe('MATCH');
    expect(by('category')?.result).toBe('MATCH');
    expect(by('companySize')?.result).toBe('MATCH');
    expect(by('decisionMaker')?.result).toBe('MATCH');
    expect(by('personLinkedin')?.result).toBe('MATCH');
    expect(by('personEmail')?.result).toBe('MATCH');
    expect(by('companySocial:linkedin')?.result).toBe('MATCH');
    expect(by('minimumScore')?.result).toBe('MATCH');
    // criteriaSnapshot remains connected to the SearchPlan via decision.criteria
    expect(decision.criteria.countIntent).toBe('exact');
    expect(decision.criteria.requestedCount).toBe(100);
  });

  it('G: latest score filtering uses newest score only', () => {
    expect(latestScorePassesFilter([
      { score: 60, calculatedAt: '2026-01-01T00:00:00.000Z' },
      { score: 75, calculatedAt: '2026-02-01T00:00:00.000Z' },
      { score: 91, calculatedAt: '2026-03-01T00:00:00.000Z' },
    ], { minScore: 80 })).toBe(true);

    expect(latestScorePassesFilter([
      { score: 60, calculatedAt: '2026-01-01T00:00:00.000Z' },
      { score: 75, calculatedAt: '2026-02-01T00:00:00.000Z' },
      { score: 91, calculatedAt: '2026-03-01T00:00:00.000Z' },
      { score: 72, calculatedAt: '2026-04-01T00:00:00.000Z' },
    ], { minScore: 80 })).toBe(false);
  });

  it('H: minimum score cannot override a failed required criterion', () => {
    const criteria = normalizeCriteria({ ...richRequiredPlan, minimumScore: 80 });
    const decision = evaluateQualification(baseContext({
      score: { value: 95, band: 'VERY_HIGH', breakdown: {} as never },
      company: { ...baseContext().company, employeeCount: 200, employeeRange: '201-500' },
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
    // Score gate is not even needed — factual failure already disqualifies.
    expect(decision.criterionResults.find((item) => item.criterion === 'minimumScore')).toBeUndefined();
  });

  it('I: QUALIFIED export applies the same filters as the Leads API', () => {
    const filters = plainToInstance(ListLeadsDto, {
      searchExecutionId: '11111111-1111-1111-1111-111111111111',
      qualificationStatus: 'QUALIFIED',
      minScore: '80',
      maxScore: '100',
      page: '1',
      limit: '25',
    });
    const mode = applyExportMode(filters, 'QUALIFIED');
    expect(mode.qualificationStatus).toBe('QUALIFIED');
    expect(mode.minScore).toBe(80);
    expect(mode.maxScore).toBe(100);
    expect(mode.searchExecutionId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('J: execution-scoped filtering is preserved on export filters', () => {
    const filters = plainToInstance(ListLeadsDto, {
      searchExecutionId: '22222222-2222-2222-2222-222222222222',
      page: '2',
    });
    const mode = applyExportMode(filters, 'ALL');
    expect(mode.searchExecutionId).toBe('22222222-2222-2222-2222-222222222222');
    expect(mode.qualificationStatus).toBeUndefined();
  });

  it('K: exclusion remains enforced', () => {
    const criteria = normalizeCriteria({ ...richRequiredPlan, exclusions: ['agencies'] });
    const decision = evaluateQualification(baseContext({
      company: {
        ...baseContext().company,
        name: 'Bright Marketing Agency',
        description: 'We are a digital marketing agency serving SaaS brands.',
        category: 'marketing_agency',
      },
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'Bright Marketing Agency is a full-service digital marketing agency.',
      }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'exclusion')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('L: person email ownership remains enforced', () => {
    const owned = assessPersonEmailOwnership({
      email: 'ada@northwind.example',
      personName: 'Ada Lovelace',
      evidence: [
        {
          id: 'a',
          sourceUrl: 'https://northwind.example/team',
          canonicalUrl: 'https://northwind.example/team',
          evidenceType: 'COMPANY_WEBSITE',
          evidenceText: 'Ada Lovelace — ada@northwind.example',
          metadata: { field: 'email', value: 'ada@northwind.example' },
          retrievedAt: new Date(),
          provider: 'website',
          sourceType: 'website',
        },
        {
          id: 'b',
          sourceUrl: 'https://news.example/p',
          canonicalUrl: 'https://news.example/p',
          evidenceType: 'WEB_SEARCH',
          evidenceText: 'Ada Lovelace contact ada@northwind.example',
          metadata: { field: 'email', value: 'ada@northwind.example' },
          retrievedAt: new Date(),
          provider: 'web_search',
          sourceType: 'web_search',
        },
      ],
      evidenceStatus: 'VERIFIED',
    });
    expect(owned.ownershipVerified).toBe(true);

    const criteria = normalizeCriteria(richRequiredPlan);
    const missingOwnership = evaluateQualification(baseContext({
      verifications: baseContext().verifications.map((item) => (
        item.field === 'email'
          ? { ...item, metadata: { ownershipVerified: false, deliverabilityVerified: true, verificationKind: 'deliverability' } }
          : item
      )),
    }), criteria);
    expect(missingOwnership.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
    expect(missingOwnership.status).not.toBe('QUALIFIED');
  });

  it('M: person/company social separation remains enforced', () => {
    expect(isCompanyProfileUrl('https://linkedin.com/company/northwind')).toBe(true);
    expect(isPersonProfileUrl('https://linkedin.com/in/ada-lovelace')).toBe(true);
    expect(isPersonProfileUrl('https://linkedin.com/company/northwind')).toBe(false);

    const criteria = normalizeCriteria(richRequiredPlan);
    const companyAsPerson = evaluateQualification(baseContext({
      contacts: [{
        ...baseContext().contacts[0],
        linkedinUrl: 'https://linkedin.com/company/northwind',
      }],
    }), criteria);
    expect(companyAsPerson.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');

    const personAsCompany = evaluateQualification(baseContext({
      socialProfiles: [{ platform: 'linkedin', profileUrl: 'https://linkedin.com/in/ada-lovelace' }],
    }), criteria);
    expect(personAsCompany.criterionResults.find((item) => item.criterion === 'companySocial:linkedin')?.result).toBe('NOT_FOUND');
  });

  it('N: decision-maker relationship verification remains enforced', () => {
    const strong = assessPersonCompanyRelationship({
      personName: 'Ada Lovelace',
      companyName: 'Northwind Software',
      companyDomain: 'northwind.example',
      title: 'CEO',
      relationshipStatus: 'current',
      relationshipVerificationStatus: 'VERIFIED',
      evidenceTexts: ['Ada Lovelace is CEO at Northwind Software.'],
      evidenceUrls: ['https://northwind.example/team'],
    });
    expect(['STRONG', 'SUPPORTED']).toContain(strong.verdict);

    const criteria = normalizeCriteria(richRequiredPlan);
    const rejected = evaluateQualification(baseContext({
      contacts: [{
        ...baseContext().contacts[0],
        companyRelationship: 'unknown',
      }],
      verifications: baseContext().verifications.filter((item) => item.field !== 'companyRelationship'),
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'Northwind builds software. Unrelated bio for someone else.',
      }],
    }), criteria);
    expect(rejected.status).not.toBe('QUALIFIED');
  });
});
