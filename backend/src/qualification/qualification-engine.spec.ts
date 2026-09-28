import { companySizeFit, evaluateQualification, normalizeCriteria } from './engine/qualification-engine';
import type { QualificationContext, QualificationCriteria } from './types/qualification.types';
import type { ScoreBreakdown } from '../scoring/types/scoring.types';

function baseContext(overrides: Partial<QualificationContext> = {}): QualificationContext {
  return {
    company: {
      id: 'company-1',
      name: 'Acme Capital',
      website: 'https://acme.test',
      email: null,
      phone: null,
      description: null,
      category: null,
      investorType: null,
      employeeCount: 25,
      employeeRange: '1-50',
      verificationStatus: 'SUPPORTED',
    },
    location: { city: 'Austin', state: 'Texas', country: 'US', postalCode: '78701' },
    contacts: [{
      id: 'contact-1',
      fullName: 'Alex Founder',
      title: 'Founder',
      normalizedRole: 'FOUNDER',
      companyRelationship: 'current',
      email: null,
      phone: null,
      linkedinUrl: 'https://linkedin.com/in/alex',
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      verificationStatus: 'VERIFIED',
    }],
    evidence: [{
      id: 'ev-1',
      evidenceType: 'COMPANY_WEBSITE',
      sourceUrl: 'https://acme.test/about',
      evidenceText: 'We buy houses for cash and build a rental acquisition portfolio.',
      provider: 'official_website',
      sourceType: 'WEBSITE',
      retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: {},
    }],
    verifications: [
      { field: 'companyName', status: 'SUPPORTED', fieldValue: 'Acme Capital', evidenceId: 'ev-1' },
      { field: 'website', status: 'SUPPORTED', fieldValue: 'https://acme.test', evidenceId: 'ev-1' },
      { field: 'state', status: 'VERIFIED', fieldValue: 'Texas', evidenceId: 'ev-1' },
      { field: 'companySize', status: 'SUPPORTED', fieldValue: '25', evidenceId: null },
      { field: 'fullName', status: 'VERIFIED', fieldValue: 'Alex Founder', evidenceId: null },
      { field: 'title', status: 'VERIFIED', fieldValue: 'Founder', evidenceId: null },
      { field: 'companyRelationship', status: 'SUPPORTED', fieldValue: 'current', evidenceId: null },
    ],
    conflicts: [],
    classification: {
      decision: 'QUALIFIED',
      confidence: 0.9,
      category: 'REAL_ESTATE_INVESTOR',
      investorType: 'CASH_HOME_BUYER',
      positiveEvidence: [{ evidenceId: 'ev-1', reason: 'cash acquisition language' }],
      negativeEvidence: [],
      missingEvidence: [],
      exclusionReason: null,
    },
    score: {
      value: 82,
      band: 'HIGH',
      breakdown: {
        total: 82,
        band: 'HIGH',
        version: 'v1',
        signals: [{ name: 'acquisition_evidence', value: true, points: 10, reason: 'Evidence contains explicit acquisition or investment language.', evidenceId: 'ev-1' }],
        availableFields: 8,
        expectedFields: 11,
        completenessPercentage: 73,
        sourceTypes: ['COMPANY_WEBSITE'],
      } satisfies ScoreBreakdown,
    },
    ...overrides,
  };
}

function criteria(overrides: Partial<QualificationCriteria> = {}): QualificationCriteria {
  return normalizeCriteria({
    industry: ['real_estate'],
    leadTypes: ['cash_home_buyer'],
    locations: [{ country: 'US', state: 'Texas' }],
    companySize: { min: 1, max: 50 },
    companyFields: ['website'],
    requiredRoles: ['Founder'],
    requiredFields: ['companyName', 'website'],
    optionalFields: ['email', 'instagram'],
    unresolvedCriteria: [],
    ...overrides,
  });
}

describe('qualification engine', () => {
  it('qualifies a lead when required criteria and evidence match', () => {
    const decision = evaluateQualification(baseContext(), criteria());
    expect(decision.status).toBe('QUALIFIED');
    expect(decision.qualifiedReasons.length).toBeGreaterThan(0);
    expect(decision.criterionResults.every((item) => item.required ? item.result === 'MATCH' || item.criterion === 'email' || item.criterion === 'instagram' : true)).toBe(true);
    expect(decision.missingOptional.some((item) => item.startsWith('email'))).toBe(true);
  });

  it('does not disqualify when optional email is missing', () => {
    const decision = evaluateQualification(baseContext({ company: { ...baseContext().company, email: null }, contacts: [{ ...baseContext().contacts[0], email: null }] }), criteria());
    expect(decision.status).toBe('QUALIFIED');
    expect(decision.missingOptional.join(' ')).toMatch(/email/i);
  });

  it('does not apply an employee-size rule when the search did not request one', () => {
    const decision = evaluateQualification(baseContext(), criteria({ companySize: undefined }));
    expect(decision.criterionResults.some((item) => item.criterion === 'companySize')).toBe(false);
    expect(decision.status).not.toBe('NOT_QUALIFIED');
  });

  it('marks needs review when required verified email is missing', () => {
    const decision = evaluateQualification(baseContext(), criteria({ requiredFields: ['companyName', 'website', 'email'], optionalFields: ['instagram'] }));
    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.needsReviewReasons.join(' ')).toMatch(/email/i);
  });

  it('disqualifies when strong negative investor evidence exists without acquisition evidence', () => {
    const decision = evaluateQualification(baseContext({
      evidence: [{
        id: 'ev-neg',
        evidenceType: 'COMPANY_WEBSITE',
        sourceUrl: 'https://broker.test/about',
        evidenceText: 'Residential real estate brokerage only. We are realtor only and do not buy properties.',
        provider: 'official_website',
        sourceType: 'WEBSITE',
        retrievedAt: new Date(),
        metadata: {},
      }],
      classification: {
        decision: 'NOT_QUALIFIED',
        confidence: 0.95,
        category: 'REAL_ESTATE_INVESTOR',
        investorType: 'NOT_DETERMINED',
        positiveEvidence: [],
        negativeEvidence: [{ evidenceId: 'ev-neg', reason: 'brokerage' }],
        missingEvidence: [],
        exclusionReason: 'brokerage only',
      },
    }), criteria());
    expect(decision.status).toBe('NOT_QUALIFIED');
    expect(decision.disqualifiedReasons.length).toBeGreaterThan(0);
  });

  it('needs review for ambiguous investor evidence', () => {
    const decision = evaluateQualification(baseContext({
      evidence: [
        {
          id: 'ev-pos',
          evidenceType: 'COMPANY_WEBSITE',
          sourceUrl: 'https://mixed.test/buy',
          evidenceText: 'We buy houses for cash across Texas.',
          provider: 'official_website',
          sourceType: 'WEBSITE',
          retrievedAt: new Date(),
          metadata: {},
        },
        {
          id: 'ev-neg',
          evidenceType: 'COMPANY_WEBSITE',
          sourceUrl: 'https://mixed.test/services',
          evidenceText: 'We also operate as a property management only division and mortgage lending only desk.',
          provider: 'official_website',
          sourceType: 'WEBSITE',
          retrievedAt: new Date(),
          metadata: {},
        },
      ],
      classification: null,
    }), criteria());
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('matches and mismatches location using stored location data only', () => {
    const match = evaluateQualification(baseContext(), criteria());
    expect(match.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('MATCH');
    const mismatch = evaluateQualification(baseContext({ location: { city: 'Miami', state: 'Florida', country: 'US', postalCode: null } }), criteria());
    expect(mismatch.status).toBe('NOT_QUALIFIED');
    expect(mismatch.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('NO_MATCH');
    const sameCityAsState = evaluateQualification(baseContext({
      location: { city: 'New York', state: null, country: null, postalCode: null },
      verifications: [],
    }), criteria({ locations: [{ country: 'US', state: 'New York' }] }));
    expect(sameCityAsState.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('MATCH');
    const cityWithoutState = evaluateQualification(baseContext({
      location: { city: 'Beverly Hills', state: null, country: null, postalCode: null },
      verifications: [],
    }), criteria({ locations: [{ country: 'US', state: 'California' }] }));
    expect(cityWithoutState.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('NEEDS_REVIEW');
    expect(cityWithoutState.status).not.toBe('NOT_QUALIFIED');
    const missing = evaluateQualification(baseContext({
      location: { city: null, state: null, country: null, postalCode: null },
      verifications: [],
    }), criteria({ locations: [{ city: 'Dubai', country: 'United Arab Emirates' }] }));
    expect(missing.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('NOT_FOUND');
    expect(missing.status).not.toBe('QUALIFIED');
    const countryOnly = evaluateQualification(baseContext({
      location: { city: null, state: null, country: 'Germany', postalCode: null },
      verifications: [],
    }), criteria({ industry: ['software'], leadTypes: [], locations: [{ country: 'DE' }], companySize: undefined, requiredRoles: [], requiredFields: [] }));
    expect(countryOnly.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('MATCH');
  });

  it('rejects an unrelated trade and does not qualify from the company name alone', () => {
    const repair = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'Desk Repair Co', category: 'it', employeeCount: null, employeeRange: null },
      evidence: [{ ...baseContext().evidence[0], evidenceText: 'Desk Repair Co provides computer repair and it support.' }],
    }), criteria({ industry: ['software'], leadTypes: [], companySize: undefined, requiredRoles: [], requiredFields: ['companyName'] }));
    expect(repair.criterionResults.find((item) => item.criterion === 'category')?.result).toBe('NO_MATCH');
    expect(repair.status).toBe('NOT_QUALIFIED');

    const nameOnly = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'Northwind Software', category: null, employeeCount: null, employeeRange: null },
      evidence: [{ ...baseContext().evidence[0], evidenceText: 'Northwind Software' }],
    }), criteria({ industry: ['software'], leadTypes: [], companySize: undefined, requiredRoles: [], requiredFields: ['companyName'] }));
    expect(nameOnly.criterionResults.find((item) => item.criterion === 'category')?.result).toBe('NEEDS_REVIEW');
    expect(nameOnly.status).not.toBe('QUALIFIED');

    const supported = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'Northwind', category: null, employeeCount: null, employeeRange: null },
      evidence: [{ ...baseContext().evidence[0], evidenceText: 'Northwind builds developer tools and application development platforms.' }],
    }), criteria({ industry: ['software'], leadTypes: [], companySize: undefined, requiredRoles: [], requiredFields: ['companyName'] }));
    expect(supported.criterionResults.find((item) => item.criterion === 'category')?.result).toBe('MATCH');
  });

  it('matches and mismatches company size without inventing counts', () => {
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 1, employeeRange: null } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 23, employeeRange: null } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 50, employeeRange: null } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 51, employeeRange: null } }), criteria()).status).toBe('NOT_QUALIFIED');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 0, employeeRange: null } }), criteria()).status).toBe('NOT_QUALIFIED');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: '1-10' } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: '11-50' } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: '10+' } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NOT_FOUND');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: 'small company' } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NOT_FOUND');
    expect(companySizeFit(23, null, { min: 1, max: 50 })).toBe('MATCHED');
    expect(companySizeFit(1, null, { min: 1, max: 50 })).toBe('MATCHED');
    expect(companySizeFit(50, null, { min: 1, max: 50 })).toBe('MATCHED');
    expect(companySizeFit(51, null, { min: 1, max: 50 })).toBe('OUTSIDE_RANGE');
    expect(companySizeFit(null, '1-10', { min: 1, max: 50 })).toBe('MATCHED');
    expect(companySizeFit(null, '11-50', { min: 1, max: 50 })).toBe('MATCHED');
    expect(companySizeFit(null, '51-200', { min: 1, max: 50 })).toBe('OUTSIDE_RANGE');
    expect(companySizeFit(null, '1-200', { min: 1, max: 50 })).toBe('UNKNOWN');
    expect(companySizeFit(null, null, { min: 1, max: 50 })).toBe('UNKNOWN');
    expect(companySizeFit(null, '10+', { min: 1, max: 50 })).toBe('UNKNOWN');
    expect(companySizeFit(null, 'small company', { min: 1, max: 50 })).toBe('UNKNOWN');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: 200 } }), criteria()).status).toBe('NOT_QUALIFIED');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: null } }), criteria()).status).toBe('NEEDS_REVIEW');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: '10-40' } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: '1-200' } }), criteria()).criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NOT_FOUND');
    expect(evaluateQualification(baseContext({ company: { ...baseContext().company, employeeCount: null, employeeRange: '51-200' } }), criteria()).status).toBe('NOT_QUALIFIED');
  });

  it('does not treat a real-estate name as investor evidence', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'ABC Real Estate' },
      evidence: [{
        id: 'ev-name',
        evidenceType: 'COMPANY_NAME',
        sourceUrl: 'https://abc.test',
        evidenceText: 'ABC Real Estate',
        provider: 'official_website',
        sourceType: 'WEBSITE',
        retrievedAt: new Date(),
        metadata: {},
      }],
      classification: null,
    }), criteria({ leadTypes: ['real_estate_investor'] }));
    expect(decision.status).not.toBe('QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'category')?.result).not.toBe('MATCH');
  });

  it('accepts explicit acquisition evidence', () => {
    const decision = evaluateQualification(baseContext({
      evidence: [{
        id: 'ev-acquire',
        evidenceType: 'COMPANY_WEBSITE',
        sourceUrl: 'https://abc.test/about',
        evidenceText: 'We acquire residential properties in Dallas and hold them in an owned-property portfolio.',
        provider: 'official_website',
        sourceType: 'WEBSITE',
        retrievedAt: new Date(),
        metadata: {},
      }],
    }), criteria({ leadTypes: ['real_estate_investor'] }));
    expect(decision.criterionResults.find((item) => item.criterion === 'real_estate_investor')?.result).toBe('MATCH');
  });

  it('verifies decision maker roles and reports missing decision makers', () => {
    expect(evaluateQualification(baseContext(), criteria()).criterionResults.find((item) => item.criterion === 'decisionMaker')?.result).toBe('MATCH');
    expect(evaluateQualification(baseContext({ contacts: [] }), criteria()).status).toBe('NEEDS_REVIEW');
  });

  it('needs review on conflicting critical evidence', () => {
    const decision = evaluateQualification(baseContext({
      conflicts: [{ fieldName: 'website', requiresReview: true, resolutionStatus: 'OPEN' }],
      verifications: baseContext().verifications.map((item) => item.field === 'website' ? { ...item, status: 'NEEDS_REVIEW' } : item),
    }), criteria());
    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.needsReviewReasons.join(' ')).toMatch(/conflict/i);
  });

  it('keeps score explainable and never lets score override required criteria failure', () => {
    const decision = evaluateQualification(baseContext({
      location: { city: 'Seattle', state: 'Washington', country: 'US', postalCode: null },
      score: { value: 90, band: 'VERY_HIGH', breakdown: baseContext().score!.breakdown },
    }), criteria({ minimumScore: 50 }));
    expect(decision.score).toBe(90);
    expect(decision.scoreBreakdown?.signals.length).toBeGreaterThan(0);
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('cannot invent evidence when none exists', () => {
    const decision = evaluateQualification(baseContext({
      evidence: [],
      classification: null,
      score: { value: 70, band: 'HIGH', breakdown: baseContext().score!.breakdown },
    }), criteria());
    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.criterionResults.find((item) => item.criterion === 'category')?.evidenceExcerpt).toBeNull();
  });

  it('supports dynamic non-real-estate industry criteria', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, category: 'software' },
      evidence: [{
        id: 'ev-saas',
        evidenceType: 'COMPANY_WEBSITE',
        sourceUrl: 'https://saas.test',
        evidenceText: 'We build software platforms for staffing agencies.',
        provider: 'official_website',
        sourceType: 'WEBSITE',
        retrievedAt: new Date(),
        metadata: {},
      }],
      classification: null,
    }), criteria({
      industry: ['software'],
      leadTypes: [],
      requiredRoles: [],
      requiredFields: ['companyName'],
      optionalFields: [],
    }));
    expect(decision.status).toBe('QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'category')?.result).toBe('MATCH');
  });

  it('normalizes required and optional fields from search plans without hard-coded cash buyer defaults', () => {
    const normalized = normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companySize: { min: 10, max: 100 },
      companyFields: ['website'],
      contactRequirements: { titles: ['CEO'], fields: ['email'] },
      requiredFields: ['email'],
      optionalFields: ['instagram'],
      unresolvedCriteria: [],
    });
    expect(normalized.requiredRoles).toEqual(['CEO']);
    expect(normalized.requiredFields).toEqual(expect.arrayContaining(['companyName', 'location', 'companySize', 'decisionMaker', 'category', 'email']));
    expect(normalized.optionalFields).toContain('instagram');
    expect(normalized.leadTypes).toEqual([]);
  });
});
