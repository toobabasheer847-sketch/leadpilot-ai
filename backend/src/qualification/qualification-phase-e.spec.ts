import { SearchPlanParser } from '../search/parsers/search-plan.parser';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import { applyExportMode } from '../exports/export-mode';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { roleMatches } from '../contacts/discovery/public-decision-maker';

function baseContext(overrides: Partial<QualificationContext> = {}): QualificationContext {
  return {
    company: {
      id: 'company-1',
      name: 'Northwind Software',
      website: 'https://northwind.example',
      email: null,
      phone: null,
      description: null,
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

describe('Phase E strict user-criteria qualification', () => {
  const parser = new SearchPlanParser();

  it('parses company and person socials as distinct required fields', () => {
    const plan = parser.parse('Find 200 software companies in California with 1-50 employees, CEO or Founder, company LinkedIn Facebook Instagram, person LinkedIn, verified person email and website.');
    expect(plan.websiteRequirement?.required).toBe(true);
    expect(plan.requiredFields).toEqual(expect.arrayContaining(['website', 'companyLinkedin', 'companyFacebook', 'companyInstagram', 'personLinkedin']));
    expect(plan.personFields).toContain('linkedin');
    expect(plan.emailRequirement?.verified).toBe(true);
    const criteria = normalizeCriteria(plan);
    expect(criteria.requiredFields).toEqual(expect.arrayContaining(['website', 'companySize', 'decisionMaker', 'personEmail']));
    expect(criteria.personRequiredFields).toContain('personLinkedin');
    expect(criteria.companyRequiredFields).toEqual(expect.arrayContaining(['companyLinkedin', 'companyFacebook', 'companyInstagram']));
  });

  it('A/B/C: required company LinkedIn/Facebook/Instagram missing → not QUALIFIED', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    for (const platform of ['linkedin', 'facebook', 'instagram'] as const) {
      const socialProfiles = baseContext().socialProfiles.filter((item) => item.platform !== platform);
      const decision = evaluateQualification(baseContext({ socialProfiles }), criteria);
      expect(decision.status).not.toBe('QUALIFIED');
      expect(decision.criterionResults.find((item) => item.criterion === `companySocial:${platform}`)?.result).toBe('NOT_FOUND');
      expect(decision.criterionResults.find((item) => item.criterion === `companySocial:${platform}`)?.required).toBe(true);
    }
  });

  it('D: required person LinkedIn missing → not QUALIFIED', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], linkedinUrl: null }],
    }), criteria);
    expect(decision.status).not.toBe('QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');
  });

  it('E: company LinkedIn cannot satisfy person LinkedIn', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], linkedinUrl: null }],
      socialProfiles: [{ platform: 'linkedin', profileUrl: 'https://linkedin.com/company/northwind' }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('F: company email cannot satisfy required person email', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, email: 'info@northwind.example' },
      contacts: [{ ...baseContext().contacts[0], email: null }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('G: required website missing → not QUALIFIED', () => {
    const criteria = normalizeCriteria({
      ...richRequiredPlan,
      websiteRequirement: { requested: true, required: true },
    });
    expect(criteria.requiredFields).toContain('website');
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, website: null },
    }), criteria);
    expect(decision.status).not.toBe('QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'website')?.result).toBe('NOT_FOUND');
  });

  it('G2: invalid social host website → NOT_QUALIFIED', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, website: 'https://linkedin.com/company/northwind' },
      verifications: baseContext().verifications.map((item) => item.field === 'website'
        ? { ...item, status: 'INVALID', fieldValue: 'https://linkedin.com/company/northwind' }
        : item),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'website')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('H: employee size 1-50 matches 49/50 and rejects 51', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 49 } }), criteria)
      .criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 50 } }), criteria)
      .criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    const over = evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 51 } }), criteria);
    expect(over.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NO_MATCH');
    expect(over.status).toBe('NOT_QUALIFIED');
  });

  it('I: required CEO matches CEO and rejects Office Manager', () => {
    expect(roleMatches('CEO', ['CEO', 'Founder'])).toBe(true);
    expect(roleMatches('Office Manager', ['CEO', 'Founder'])).toBe(false);
    const criteria = normalizeCriteria(richRequiredPlan);
    const bad = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], title: 'Office Manager', normalizedRole: 'OFFICE_MANAGER' }],
    }), criteria);
    expect(bad.criterionResults.find((item) => item.criterion === 'decisionMaker')?.result).toBe('NO_MATCH');
  });

  it('J: high score cannot override required criterion failure', () => {
    const criteria = normalizeCriteria({ ...richRequiredPlan, minimumScore: 80 });
    const decision = evaluateQualification(baseContext({
      score: { value: 95, band: 'VERY_HIGH', breakdown: {} as never },
      contacts: [{ ...baseContext().contacts[0], linkedinUrl: null }],
    }), criteria);
    expect(decision.status).not.toBe('QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');
  });

  it('K: plan minimumScore 80 excludes 79 and includes 80/95 once factual criteria pass', () => {
    const criteria = normalizeCriteria({ ...richRequiredPlan, minimumScore: 80 });
    expect(evaluateQualification(baseContext({ score: { value: 79, band: 'HIGH', breakdown: {} as never } }), criteria).status).toBe('NOT_QUALIFIED');
    expect(evaluateQualification(baseContext({ score: { value: 80, band: 'HIGH', breakdown: {} as never } }), criteria).status).toBe('QUALIFIED');
    expect(evaluateQualification(baseContext({ score: { value: 95, band: 'VERY_HIGH', breakdown: {} as never } }), criteria).status).toBe('QUALIFIED');
  });

  it('L/O/P: QUALIFIED + minScore export filters combine without inventing values', () => {
    const filters = plainToInstance(ListLeadsDto, { qualificationStatus: 'QUALIFIED', minScore: '80', maxScore: '100' });
    const mode = applyExportMode(filters, 'QUALIFIED');
    expect(mode.qualificationStatus).toBe('QUALIFIED');
    expect(mode.minScore).toBe(80);
    expect(mode.maxScore).toBe(100);
  });

  it('M/N: score filter DTO validates organization-scoped query bounds and pagination', async () => {
    const ok = plainToInstance(ListLeadsDto, { page: '2', limit: '25', minScore: '80', maxScore: '90', qualificationStatus: 'QUALIFIED', sortBy: 'score' });
    expect(await validate(ok)).toHaveLength(0);
    expect(ok.minScore).toBe(80);
    expect(ok.page).toBe(2);
    const bad = plainToInstance(ListLeadsDto, { minScore: '101', page: '0' });
    expect((await validate(bad)).length).toBeGreaterThan(0);
  });

  it('Q: missing required values stay NOT_FOUND and are never fabricated', () => {
    const criteria = normalizeCriteria(richRequiredPlan);
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, website: null, email: null, employeeCount: null, employeeRange: null },
      contacts: [],
      socialProfiles: [],
    }), criteria);
    expect(decision.status).not.toBe('QUALIFIED');
    expect(decision.criterionResults.some((item) => item.result === 'NOT_FOUND' && item.required)).toBe(true);
    expect(decision.criterionResults.find((item) => item.criterion === 'website')?.evidenceExcerpt ?? null).toBeNull();
  });

  it('websiteRequirement.required alone wires into qualification without inventing a site', () => {
    const criteria = normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      requiredFields: [],
      websiteRequirement: { requested: true, required: true },
      unresolvedCriteria: [],
    });
    expect(criteria.requiredFields).toContain('website');
    const decision = evaluateQualification(baseContext({ company: { ...baseContext().company, website: null } }), criteria);
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('generic social profiles with soft preference stay optional (Phase C preserved)', () => {
    const plan = parser.parse('Find 20 software companies in California, ideally with social profiles if available');
    const criteria = normalizeCriteria(plan);
    const missing = evaluateQualification(baseContext({
      socialProfiles: [],
      contacts: [],
      company: { ...baseContext().company, employeeCount: null, employeeRange: null },
    }), criteria);
    expect(missing.criterionResults.filter((item) => item.criterion.startsWith('companySocial:')).every((item) => !item.required)).toBe(true);
  });

  it('with social profiles in mandatory language requires company platforms', () => {
    const plan = parser.parse('Find 20 software companies in California with social profiles');
    expect(plan.requiredFields).toEqual(expect.arrayContaining(['companyLinkedin', 'companyFacebook', 'companyInstagram']));
    const criteria = normalizeCriteria(plan);
    const missing = evaluateQualification(baseContext({
      socialProfiles: [],
      contacts: [],
      company: { ...baseContext().company, employeeCount: null, employeeRange: null },
    }), criteria);
    expect(missing.status).not.toBe('QUALIFIED');
    expect(missing.criterionResults.some((item) => item.criterion.startsWith('companySocial:') && item.required && item.result === 'NOT_FOUND')).toBe(true);
  });

  it('exposes criterion-level results on the qualification decision', () => {
    const decision = evaluateQualification(baseContext(), normalizeCriteria(richRequiredPlan));
    expect(decision.criterionResults.length).toBeGreaterThan(3);
    expect(decision.criterionResults.every((item) => item.criterion && item.result)).toBe(true);
  });
});
