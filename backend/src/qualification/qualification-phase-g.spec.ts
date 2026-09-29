import { SearchPlanParser } from '../search/parsers/search-plan.parser';
import {
  countShortfall,
  discoveryAcceptanceCap,
  discoveryTarget,
  explicitResultCount,
  latestScorePassesFilter,
  resolveCountIntent,
} from '../search/search-plan.limits';
import { assessExclusion, assessPlanExclusions } from '../search/exclusion-evidence';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import { applyExportMode } from '../exports/export-mode';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { plainToInstance } from 'class-transformer';
import { assessWebCompanyCandidate } from '../sources/providers/web-search/company-discovery.assess';
import { isGenericBusinessEmail } from '../verification/utils/generic-email';

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
      companyRelationship: 'current',
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
      sourceUrl: 'https://northwind.example/about',
      evidenceText: 'Northwind builds software platforms for enterprises.',
      provider: 'official_website',
      sourceType: 'WEBSITE',
      retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: {},
    }],
    verifications: [
      { field: 'companyName', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
      { field: 'website', status: 'SUPPORTED', fieldValue: 'https://northwind.example', evidenceId: 'ev-1' },
      { field: 'state', status: 'VERIFIED', fieldValue: 'California', evidenceId: 'ev-1' },
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
  unresolvedCriteria: [] as Array<{ text: string; reason: string }>,
};

describe('Phase G countIntent, exclusions, and plan traceability', () => {
  const parser = new SearchPlanParser();

  it('A: Find 50 → exact countIntent and discovery target 50', () => {
    const plan = parser.parse('Find 50 software companies in California');
    expect(plan.requestedCount).toBe(50);
    expect(plan.countIntent).toBe('exact');
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryTarget(plan)).toBe(50);
    expect(discoveryAcceptanceCap(plan)).toBe(50);
    expect(explicitResultCount(plan)).toBe(50);
  });

  it('B: Find up to 50 → maximum; never intentionally accept >50', () => {
    const plan = parser.parse('Find up to 50 software companies in California');
    expect(plan.countIntent).toBe('maximum');
    expect(discoveryTarget(plan)).toBe(50);
    expect(discoveryAcceptanceCap(plan)).toBe(50);
    expect(countShortfall(plan, 40)).toBe(10);
    expect(countShortfall(plan, 50)).toBe(0);
  });

  it('C: Find at least 50 → minimum; over-seek allowed; honest shortfall', () => {
    const plan = parser.parse('Find at least 50 software companies in California');
    expect(plan.countIntent).toBe('minimum');
    expect(discoveryTarget(plan)).toBeGreaterThanOrEqual(50);
    expect(discoveryTarget(plan)).toBe(Math.ceil(50 * 1.25));
    expect(discoveryAcceptanceCap(plan)).toBeGreaterThan(50);
    expect(countShortfall(plan, 40)).toBe(10);
    expect(countShortfall(plan, 50)).toBe(0);
    expect(countShortfall(plan, 60)).toBe(0);
  });

  it('D: Find around 50 → approximate intent preserved', () => {
    const plan = parser.parse('Find around 50 software companies in California');
    expect(plan.countIntent).toBe('approximate');
    expect(plan.requestedCount).toBe(50);
    expect(discoveryTarget(plan)).toBe(50);
    expect(discoveryAcceptanceCap(plan)).toBe(50);
  });

  it('E: excluding agencies is preserved on the plan and criteria', () => {
    const plan = parser.parse('Find software companies in California excluding agencies');
    expect(plan.exclusions).toEqual(expect.arrayContaining([expect.stringMatching(/agenc/i)]));
    const criteria = normalizeCriteria(plan);
    expect(criteria.exclusions.length).toBeGreaterThan(0);
    expect(criteria.industry).toEqual(expect.arrayContaining(['software']));
    expect(criteria.locations.some((item) => item.state === 'California')).toBe(true);
  });

  it('F: clear exclusion match → NOT_QUALIFIED', () => {
    const criteria = normalizeCriteria({
      ...richRequiredPlan,
      exclusions: ['agencies'],
    });
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

  it('G: ambiguous exclusion evidence does not fabricate exclusion', () => {
    const assessment = assessExclusion('hotel restaurants', 'Family Kitchen serves seasonal menus downtown.', 'Hotel Corp Holdings');
    expect(assessment.verdict).not.toBe('EXCLUDED');
    expect(['CLEAR', 'AMBIGUOUS']).toContain(assessment.verdict);

    const criteria = normalizeCriteria({
      ...richRequiredPlan,
      exclusions: ['hotel restaurants'],
    });
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'Hotel Soft Labs', description: 'Enterprise software for hotels.' },
      evidence: [{ ...baseContext().evidence[0], evidenceText: 'Hotel Soft Labs builds property management software.' }],
    }), criteria);
    const exclusion = decision.criterionResults.find((item) => item.criterion === 'exclusion');
    expect(exclusion?.result).not.toBe('NO_MATCH');
    expect(decision.status).not.toBe('NOT_QUALIFIED');
  });

  it('H: latest score filtering includes company when latest is above minScore', () => {
    expect(latestScorePassesFilter([
      { score: 60, calculatedAt: '2026-01-01T00:00:00.000Z' },
      { score: 75, calculatedAt: '2026-02-01T00:00:00.000Z' },
      { score: 91, calculatedAt: '2026-03-01T00:00:00.000Z' },
    ], { minScore: 80 })).toBe(true);
  });

  it('I: latest score filtering excludes company when latest is below minScore', () => {
    expect(latestScorePassesFilter([
      { score: 90, calculatedAt: '2026-01-01T00:00:00.000Z' },
      { score: 72, calculatedAt: '2026-02-01T00:00:00.000Z' },
    ], { minScore: 80 })).toBe(false);
  });

  it('J: required social missing → NOT_QUALIFIED', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      socialProfiles: baseContext().socialProfiles.filter((item) => item.platform !== 'linkedin'),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'companySocial:linkedin')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('K: required person email without ownership → NEEDS_REVIEW (Phase F preserved)', () => {
    expect(isGenericBusinessEmail('info@northwind.example')).toBe(true);
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      verifications: baseContext().verifications.map((item) => item.field === 'email'
        ? {
          ...item,
          status: 'SUPPORTED',
          metadata: { ownershipVerified: false, verificationKind: 'evidence_supported', sourceCount: 1 },
        }
        : item),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('L: required criteria pass + score pass → QUALIFIED', () => {
    const criteria = normalizeCriteria({ ...richRequiredPlan, minimumScore: 80 });
    expect(evaluateQualification(baseContext({ score: { value: 92, band: 'VERY_HIGH', breakdown: {} as never } }), criteria).status).toBe('QUALIFIED');
  });

  it('M: required criterion fails + high score → NOT_QUALIFIED', () => {
    const criteria = normalizeCriteria({ ...richRequiredPlan, minimumScore: 80 });
    const decision = evaluateQualification(baseContext({
      score: { value: 99, band: 'VERY_HIGH', breakdown: {} as never },
      company: { ...baseContext().company, employeeCount: 200 },
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('N: export with qualification + score filters matches Leads API filter population', () => {
    const filters = plainToInstance(ListLeadsDto, {
      qualificationStatus: 'QUALIFIED',
      minScore: '80',
      maxScore: '100',
      searchExecutionId: '11111111-1111-1111-1111-111111111111',
    });
    const mode = applyExportMode(filters, 'QUALIFIED');
    expect(mode.qualificationStatus).toBe('QUALIFIED');
    expect(mode.minScore).toBe(80);
    expect(mode.maxScore).toBe(100);
    expect(mode.searchExecutionId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('traceability: normalizeCriteria retains countIntent, exclusions, and key required fields', () => {
    const plan = parser.parse('Find at least 25 software companies in California excluding agencies with website and verified person email');
    const criteria = normalizeCriteria(plan);
    expect(criteria.countIntent).toBe('minimum');
    expect(criteria.requestedCount).toBe(25);
    expect(criteria.exclusions.some((item) => /agenc/i.test(item))).toBe(true);
    expect(criteria.requiredFields).toEqual(expect.arrayContaining(['website', 'personEmail', 'location', 'category']));
    expect(criteria.verifiedEmailRequired).toBe(true);
  });

  it('discovery rejects clear exclusion matches without fabricating acceptance', () => {
    const plan = parser.parse('Find restaurants in Dubai excluding hotel restaurants');
    expect(plan.exclusions?.some((item) => /hotel/i.test(item))).toBe(true);
    const rejected = assessWebCompanyCandidate({
      title: 'Grand Hotel Restaurant — Dubai',
      url: 'https://grandhotelrestaurant.example',
      snippet: 'Fine dining hotel restaurant inside the Grand Hotel Dubai.',
      source: 'tavily',
      retrievedAt: new Date().toISOString(),
    }, plan);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) expect(rejected.reason).toBe('EXCLUSION_MATCH');

    const clear = assessPlanExclusions({
      exclusions: plan.exclusions ?? [],
      text: 'Independent beach cafe serving local seafood.',
      companyName: 'Seaside Cafe',
      category: 'restaurant',
    });
    expect(clear.every((item) => item.verdict !== 'EXCLUDED')).toBe(true);
  });

  it('broker exclusion for real-estate investment plans remains evidence-based', () => {
    const plan = parser.parse('Find real estate investment companies in Texas, but exclude brokers');
    expect(plan.exclusions?.some((item) => /broker/i.test(item))).toBe(true);
    const excluded = assessExclusion(
      'brokers',
      'We are a licensed real estate brokerage helping buyers find homes.',
      'Texas Realty Brokers',
    );
    expect(excluded.verdict).toBe('EXCLUDED');
  });
});
