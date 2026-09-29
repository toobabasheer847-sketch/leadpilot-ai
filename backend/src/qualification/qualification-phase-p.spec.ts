import { mapWithConcurrency } from '../common/concurrency';
import { isCompanyProfileUrl, isPersonProfileUrl } from '../contacts/discovery/public-decision-maker';
import { assessPersonCompanyRelationship } from '../contacts/discovery/person-company-relationship';
import { SearchPlanParser } from '../search/parsers/search-plan.parser';
import {
  discoveryTarget,
  latestScorePassesFilter,
  qualifiedShortfall,
  resolveCountIntent,
} from '../search/search-plan.limits';
import { evaluateQualification, normalizeCriteria } from './engine/qualification-engine';
import { applyFinalDataQualityGate, allRequiredCriteriaMatched } from './engine/final-quality-gate';
import type { QualificationContext, QualificationCriteria } from './types/qualification.types';

function baseContext(overrides: Partial<QualificationContext> = {}): QualificationContext {
  return {
    company: {
      id: 'company-1',
      name: 'Oak Stream Investors',
      website: 'https://oak.example',
      email: null,
      phone: null,
      description: 'We buy houses for cash and specialize in fix and flip and wholesaling across Texas.',
      category: 'real_estate',
      investorType: 'CASH_HOME_BUYER',
      employeeCount: 12,
      employeeRange: '1-50',
      verificationStatus: 'SUPPORTED',
    },
    socialProfiles: [
      { platform: 'linkedin', profileUrl: 'https://linkedin.com/company/oak-stream' },
    ],
    location: { city: 'Austin', state: 'Texas', country: 'US', postalCode: '78701' },
    contacts: [{
      id: 'contact-1',
      fullName: 'Ada Example',
      title: 'CEO',
      normalizedRole: 'CEO',
      companyRelationship: 'current',
      email: 'ada@oak.example',
      phone: null,
      linkedinUrl: 'https://linkedin.com/in/ada-example',
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      verificationStatus: 'SUPPORTED',
    }],
    evidence: [{
      id: 'ev-1',
      evidenceType: 'COMPANY_WEBSITE',
      sourceUrl: 'https://oak.example/about',
      evidenceText: 'Oak Stream Investors buys houses for cash in Texas. We specialize in fix and flip and real estate wholesaling. Ada Example is CEO of Oak Stream Investors.',
      provider: 'official_website',
      sourceType: 'WEBSITE',
      retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: {},
    }],
    verifications: [
      { field: 'companyName', status: 'SUPPORTED', fieldValue: 'Oak Stream Investors', evidenceId: 'ev-1' },
      { field: 'website', status: 'SUPPORTED', fieldValue: 'https://oak.example', evidenceId: 'ev-1' },
      { field: 'state', status: 'VERIFIED', fieldValue: 'Texas', evidenceId: 'ev-1' },
      { field: 'companySize', status: 'SUPPORTED', fieldValue: '12', evidenceId: null },
      { field: 'fullName', status: 'SUPPORTED', fieldValue: 'Ada Example', evidenceId: 'ev-1' },
      { field: 'title', status: 'SUPPORTED', fieldValue: 'CEO', evidenceId: 'ev-1' },
      { field: 'companyRelationship', status: 'SUPPORTED', fieldValue: 'Oak Stream Investors', evidenceId: 'ev-1' },
    ],
    conflicts: [],
    classification: {
      decision: 'QUALIFIED',
      confidence: 0.91,
      category: 'REAL_ESTATE_INVESTOR',
      investorType: 'CASH_HOME_BUYER',
      positiveEvidence: [{ evidenceId: 'ev-1', reason: 'cash buyer / flip / wholesale' }],
      negativeEvidence: [],
      missingEvidence: [],
      exclusionReason: null,
    },
    score: { value: 88, band: 'HIGH', breakdown: {} as never },
    ...overrides,
  };
}

function texasInvestorCriteria(overrides: Partial<QualificationCriteria> = {}): QualificationCriteria {
  return normalizeCriteria({
    industry: ['real_estate'],
    leadTypes: ['cash_home_buyer', 'fix_and_flip', 'wholesaler'],
    locations: [{ country: 'US', state: 'Texas' }],
    companySize: { min: 1, max: 50 },
    companyFields: ['website'],
    requiredRoles: ['CEO'],
    requiredFields: ['companyName', 'website'],
    optionalFields: [],
    exclusions: [],
    requestedCount: 300,
    countIntent: 'exact',
    unresolvedCriteria: [],
    ...overrides,
  });
}

describe('Phase P lead relevance, criteria enforcement, and final data-quality gate', () => {
  const parser = new SearchPlanParser();

  it('A. correct category → PASS', () => {
    const decision = evaluateQualification(baseContext(), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'category' || item.criterion === 'cash_home_buyer')?.result).toBe('MATCH');
    expect(decision.status).toBe('QUALIFIED');
  });

  it('B. unrelated category → NOT_QUALIFIED', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'Lens & Key Photo', category: 'photography', investorType: null },
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'Lens & Key Photo is a real estate photographer serving Austin listings.',
      }],
      classification: {
        decision: 'NOT_QUALIFIED',
        confidence: 0.9,
        category: 'REAL_ESTATE_INVESTOR',
        investorType: 'NOT_DETERMINED',
        positiveEvidence: [],
        negativeEvidence: [{ evidenceId: 'ev-1', reason: 'photographer' }],
        missingEvidence: [],
        exclusionReason: 'real estate photographer',
      },
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'category')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('C. correct Texas company → PASS (TX / Tex. normalize)', () => {
    const asTx = evaluateQualification(baseContext({
      location: { city: 'Houston', state: 'TX', country: 'US', postalCode: null },
    }), texasInvestorCriteria());
    expect(asTx.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('MATCH');

    const asTex = evaluateQualification(baseContext({
      location: { city: 'Dallas', state: 'Tex.', country: 'US', postalCode: null },
    }), texasInvestorCriteria({ locations: [{ country: 'US', state: 'Texas' }] }));
    expect(asTex.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('MATCH');
  });

  it('D. company outside Texas → NOT_QUALIFIED', () => {
    const decision = evaluateQualification(baseContext({
      location: { city: 'Miami', state: 'Florida', country: 'US', postalCode: null },
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('E. person in Texas but company outside Texas → NOT_QUALIFIED', () => {
    // Location gate uses company_locations only — contact geography must never satisfy company location.
    const decision = evaluateQualification(baseContext({
      location: { city: 'Seattle', state: 'Washington', country: 'US', postalCode: null },
      contacts: [{
        ...baseContext().contacts[0],
        // Even if person evidence mentions Texas, company HQ is Washington.
      }],
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'Ada Example lives in Texas. Oak Stream operates from Seattle, Washington. We buy houses for cash.',
      }],
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'location')?.source).toBe('company_locations');
    expect(decision.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('F. requested specialization present → PASS', () => {
    const decision = evaluateQualification(baseContext(), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'specialization')?.result).toBe('MATCH');
  });

  it('G. specialization absent → NEEDS_REVIEW where appropriate', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, investorType: null, description: 'Real estate investment company.' },
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'We acquire residential properties and build an investment portfolio in Texas.',
      }],
      classification: {
        decision: 'QUALIFIED',
        confidence: 0.8,
        category: 'REAL_ESTATE_INVESTOR',
        investorType: 'REAL_ESTATE_INVESTOR',
        positiveEvidence: [{ evidenceId: 'ev-1', reason: 'acquisition' }],
        negativeEvidence: [],
        missingEvidence: [],
        exclusionReason: null,
      },
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'specialization')?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('H. explicit exclusion match → NOT_QUALIFIED', () => {
    const decision = evaluateQualification(baseContext({
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'We buy houses for cash and also run a dedicated property management division for clients.',
      }],
    }), texasInvestorCriteria({ exclusions: ['property managers', 'property management'] }));
    expect(decision.criterionResults.find((item) => item.criterion === 'exclusion')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('I. ambiguous exclusion → NEEDS_REVIEW', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, name: 'Manager Capital Group' },
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'Manager Capital Group buys houses for cash and specializes in fix and flip.',
      }],
    }), texasInvestorCriteria({ exclusions: ['property managers'] }));
    const exclusion = decision.criterionResults.find((item) => item.criterion === 'exclusion');
    expect(exclusion?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('J. employee size 1–50 → PASS', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, employeeCount: 50, employeeRange: null },
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('MATCH');
  });

  it('K. employee size >50 → NOT_QUALIFIED', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, employeeCount: 100, employeeRange: null },
      score: { value: 98, band: 'VERY_HIGH', breakdown: {} as never },
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('L. missing employee size → NEEDS_REVIEW', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, employeeCount: null, employeeRange: null },
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'companySize')?.result).toBe('NOT_FOUND');
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('M. correct decision maker relationship → PASS', () => {
    const decision = evaluateQualification(baseContext(), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'decisionMaker')?.result).toBe('MATCH');
  });

  it('N. wrong-company person → NO_MATCH', () => {
    const relationship = assessPersonCompanyRelationship({
      personName: 'Jordan Other',
      title: 'CEO',
      companyName: 'Oak Stream Investors',
      companyWebsite: 'https://oak.example',
      companyRelationship: null,
      evidence: [{
        sourceUrl: 'https://other.example/team',
        evidenceText: 'Jordan Other is CEO of Other Capital Partners.',
        field: 'companyRelationship',
      }],
      relationshipVerificationStatus: null,
    });
    expect(relationship.verdict).toBe('REJECTED');

    const decision = evaluateQualification(baseContext({
      contacts: [{
        ...baseContext().contacts[0],
        fullName: 'Jordan Other',
        title: 'CEO',
        companyRelationship: null,
        linkedinUrl: null,
      }],
      evidence: [
        {
          id: 'ev-wrong',
          evidenceType: 'WEB_SEARCH',
          sourceUrl: 'https://other.example/team',
          evidenceText: 'Jordan Other is CEO of Other Capital Partners.',
          provider: 'web_search',
          sourceType: 'WEB_SEARCH',
          retrievedAt: new Date(),
          metadata: { field: 'companyRelationship' },
        },
        {
          id: 'ev-1',
          evidenceType: 'COMPANY_WEBSITE',
          sourceUrl: 'https://oak.example/about',
          evidenceText: 'Oak Stream Investors buys houses for cash and specializes in fix and flip in Texas.',
          provider: 'official_website',
          sourceType: 'WEBSITE',
          retrievedAt: new Date(),
          metadata: {},
        },
      ],
      verifications: baseContext().verifications.filter((item) => item.field !== 'companyRelationship' && item.field !== 'fullName'),
    }), texasInvestorCriteria());
    expect(decision.criterionResults.find((item) => item.criterion === 'decisionMaker')?.result).toBe('NO_MATCH');
    expect(decision.status).toBe('NOT_QUALIFIED');
  });

  it('O. company LinkedIn does not satisfy person LinkedIn', () => {
    expect(isCompanyProfileUrl('https://linkedin.com/company/oak-stream')).toBe(true);
    expect(isPersonProfileUrl('https://linkedin.com/company/oak-stream')).toBe(false);
    const personCriteria = normalizeCriteria({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      companyFields: [],
      personFields: ['personLinkedin'],
      requiredRoles: ['CEO'],
      requiredFields: ['companyName', 'personLinkedin'],
      unresolvedCriteria: [],
    });
    const result = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], linkedinUrl: 'https://linkedin.com/company/oak-stream' }],
    }), personCriteria);
    expect(result.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');
    expect(result.status).not.toBe('QUALIFIED');
  });

  it('P. person LinkedIn does not satisfy company LinkedIn', () => {
    expect(isPersonProfileUrl('https://linkedin.com/in/ada-example')).toBe(true);
    const criteria = normalizeCriteria({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      companyFields: [],
      socialPlatforms: ['linkedin'],
      requiredRoles: ['CEO'],
      requiredFields: ['companyName', 'companyLinkedin'],
      unresolvedCriteria: [],
    });
    const decision = evaluateQualification(baseContext({
      socialProfiles: [{ platform: 'linkedin', profileUrl: 'https://linkedin.com/in/ada-example' }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'companySocial:linkedin')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('Q. requested field missing → NOT_QUALIFIED / NEEDS_REVIEW', () => {
    const criteria = normalizeCriteria({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      companyFields: [],
      requiredRoles: ['CEO'],
      requiredFields: ['companyName', 'website'],
      websiteRequirement: { requested: true, required: true },
      unresolvedCriteria: [],
    });
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, website: null },
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'website')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('R. unrequested field missing → must NOT block qualification', () => {
    const criteria = normalizeCriteria({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      companyFields: [],
      requiredRoles: [],
      requiredFields: ['companyName'],
      unresolvedCriteria: [],
    });
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, website: null, email: null },
      contacts: [],
      socialProfiles: [],
    }), criteria);
    expect(decision.criterionResults.some((item) => item.criterion === 'website' && item.required)).toBe(false);
    expect(decision.criterionResults.some((item) => item.criterion === 'decisionMaker')).toBe(false);
    expect(decision.criterionResults.some((item) => item.criterion.startsWith('companySocial:') && item.required)).toBe(false);
    expect(decision.status).toBe('QUALIFIED');
  });

  it('S. high score cannot override failed factual criterion', () => {
    const decision = evaluateQualification(baseContext({
      location: { city: 'Denver', state: 'Colorado', country: 'US', postalCode: null },
      score: { value: 99, band: 'VERY_HIGH', breakdown: {} as never },
    }), texasInvestorCriteria({ minimumScore: 50 }));
    expect(decision.score).toBe(99);
    expect(decision.status).toBe('NOT_QUALIFIED');
    const gated = applyFinalDataQualityGate(decision);
    expect(gated.status).toBe('NOT_QUALIFIED');
    expect(allRequiredCriteriaMatched(gated.criterionResults)).toBe(false);
  });

  it('T. latest score filtering remains correct', () => {
    expect(latestScorePassesFilter([
      { score: 60, calculatedAt: '2026-01-01' },
      { score: 75, calculatedAt: '2026-01-02' },
      { score: 91, calculatedAt: '2026-01-03' },
    ], { minScore: 80 })).toBe(true);
    expect(latestScorePassesFilter([
      { score: 95, calculatedAt: '2026-01-01' },
      { score: 88, calculatedAt: '2026-01-02' },
      { score: 72, calculatedAt: '2026-01-03' },
    ], { minScore: 80 })).toBe(false);
    expect(latestScorePassesFilter([
      { score: 91, calculatedAt: '2026-01-03' },
    ], { minScore: 80, maxScore: 90 })).toBe(false);
  });

  it('U. countIntent remains correct and never fabricates 300', () => {
    const plan = parser.parse('Find exactly 300 real estate investment companies in Texas specializing in cash home buyers, fix and flip, or wholesaling with employee size 1-50');
    expect(plan.requestedCount).toBe(300);
    expect(resolveCountIntent(plan)).toBe('exact');
    expect(discoveryTarget(plan)).toBe(300);
    expect(qualifiedShortfall(plan, 19)).toBe(281);
    expect(qualifiedShortfall(plan, 300)).toBe(0);
  });

  it('V. criteriaSnapshot matches normalized criteria', () => {
    const plan = {
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer', 'fix_and_flip', 'wholesaler'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      companyFields: ['website'],
      requiredRoles: ['CEO'],
      requiredFields: ['website'],
      exclusions: ['property managers'],
      requestedCount: 300,
      countIntent: 'exact' as const,
      unresolvedCriteria: [],
    };
    const criteria = normalizeCriteria(plan);
    const decision = evaluateQualification(baseContext(), criteria);
    expect(decision.criteria).toEqual(criteria);
    expect(decision.criteria.locations).toEqual([{ country: 'US', state: 'Texas' }]);
    expect(decision.criteria.companySize).toEqual({ min: 1, max: 50 });
    expect(decision.criteria.exclusions.some((item) => /property/i.test(item))).toBe(true);
    expect(decision.criteria.countIntent).toBe('exact');
    expect(decision.criteria.requestedCount).toBe(300);
    expect(decision.criterionResults.some((item) => item.criterion === 'specialization')).toBe(true);
  });

  it('W. organization isolation remains intact in criteria evaluation inputs', () => {
    const orgA = baseContext({ company: { ...baseContext().company, id: 'org-a-company-1' } });
    const orgB = baseContext({
      company: { ...baseContext().company, id: 'org-b-company-1', name: 'Other Org Co' },
      location: { city: 'Miami', state: 'Florida', country: 'US', postalCode: null },
    });
    const a = evaluateQualification(orgA, texasInvestorCriteria());
    const b = evaluateQualification(orgB, texasInvestorCriteria());
    expect(a.status).toBe('QUALIFIED');
    expect(b.status).toBe('NOT_QUALIFIED');
    expect(a.criteria).toEqual(b.criteria);
  });

  it('X. 300-company bounded validation does not create unbounded concurrency', async () => {
    const companies = Array.from({ length: 300 }, (_, index) => baseContext({
      company: {
        ...baseContext().company,
        id: `org-a-company-${index + 1}`,
        employeeCount: index % 17 === 0 ? 120 : 12,
      },
      location: index % 11 === 0
        ? { city: 'Miami', state: 'Florida', country: 'US', postalCode: null }
        : { city: 'Austin', state: 'Texas', country: 'US', postalCode: '78701' },
    }));
    const criteria = texasInvestorCriteria();
    let maxInFlight = 0;
    let inFlight = 0;
    const decisions = await mapWithConcurrency(companies, 8, async (context) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      const decision = evaluateQualification(context, criteria);
      inFlight -= 1;
      return decision;
    }, { maxConcurrency: 16 });

    expect(decisions).toHaveLength(300);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(decisions.every((item) => item.criteria === criteria || item.criteria.requestedCount === 300)).toBe(true);
    expect(decisions.some((item) => item.status === 'NOT_QUALIFIED')).toBe(true);
    expect(decisions.some((item) => item.status === 'QUALIFIED')).toBe(true);
    expect(qualifiedShortfall({ requestedCount: 300, countIntent: 'exact' }, decisions.filter((item) => item.status === 'QUALIFIED').length)).toBeGreaterThan(0);
  });

  it('Y. wholesaling is investor-positive, not a disqualifier', () => {
    const decision = evaluateQualification(baseContext({
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'We are a real estate wholesaler specializing in off-market residential deals in Texas.',
      }],
      classification: {
        decision: 'QUALIFIED',
        confidence: 0.88,
        category: 'REAL_ESTATE_INVESTOR',
        investorType: 'WHOLESALER',
        positiveEvidence: [{ evidenceId: 'ev-1', reason: 'wholesaling' }],
        negativeEvidence: [],
        missingEvidence: [],
        exclusionReason: null,
      },
    }), texasInvestorCriteria({ leadTypes: ['wholesaler'] }));
    expect(decision.criterionResults.find((item) => item.criterion === 'category')?.result).not.toBe('NO_MATCH');
    expect(decision.criterionResults.find((item) => item.criterion === 'specialization')?.result).toBe('MATCH');
    expect(decision.status).not.toBe('NOT_QUALIFIED');
  });

  it('Z. postal code location match is supported', () => {
    const decision = evaluateQualification(baseContext({
      location: { city: 'Austin', state: 'Texas', country: 'US', postalCode: '78701' },
    }), texasInvestorCriteria({
      locations: [{ country: 'US', state: 'Texas', postalCode: '78701' }],
    }));
    expect(decision.criterionResults.find((item) => item.criterion === 'location')?.result).toBe('MATCH');
  });
});
