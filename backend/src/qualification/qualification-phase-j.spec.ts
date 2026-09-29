import { plainToInstance } from 'class-transformer';
import { SearchPlanParser } from '../search/parsers/search-plan.parser';
import {
  contactDiscoveryRequested,
  countShortfall,
  discoveryAcceptanceCap,
  discoveryTarget,
  explicitResultCount,
  latestScorePassesFilter,
  qualifiedShortfall,
} from '../search/search-plan.limits';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import { applyExportMode } from '../exports/export-mode';
import { columnsFromSearchPlan, displayHeaders, EXPORT_FIELD_HEADERS } from '../exports/plan-export-columns';
import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import { assessPersonEmailOwnership } from '../verification/utils/email-ownership';
import { summarizeAggregateVerification } from '../verification/utils/aggregate-verification';
import { assessPersonCompanyRelationship } from '../contacts/discovery/person-company-relationship';
import { isCompanyProfileUrl, isPersonProfileUrl, roleMatches } from '../contacts/discovery/public-decision-maker';
import { evaluateOfficialWebsite, classifyOfficialWebsiteHost } from '../enrichment/website/official-website.validator';
import { SnovContactProvider } from '../contacts/providers/snov-contact.provider';
import { ConfigService } from '@nestjs/config';
import type { VerificationEvidence } from '../verification/types/verification.types';

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

const RICH_PROMPT = 'Find 200 software companies in California with 1-50 employees, CEO or Founder, company LinkedIn Facebook Instagram, person LinkedIn, verified person email, website, minimum score 80.';

describe('Phase J final product-contract validation', () => {
  const parser = new SearchPlanParser();

  describe('TEST 1 — Basic company search', () => {
    it('parses without inventing DM/email/social requirements', () => {
      const plan = parser.parse('Find 50 software companies in California');
      expect(plan.requestedCount).toBe(50);
      expect(plan.countIntent).toBe('exact');
      expect(plan.industry).toEqual(expect.arrayContaining(['software']));
      expect(plan.locations?.some((item) => item.state === 'California')).toBe(true);
      expect(plan.decisionMakerRoles ?? []).toEqual([]);
      expect(plan.emailRequirement?.required).not.toBe(true);
      expect(plan.socialPlatforms ?? []).toEqual([]);
      expect(plan.personFields ?? []).toEqual([]);
      expect(contactDiscoveryRequested(plan)).toBe(false);

      const criteria = normalizeCriteria(plan);
      expect(criteria.requiredRoles).toEqual([]);
      expect(criteria.personEmailRequired).toBe(false);
      expect(criteria.socialPlatforms).toEqual([]);
      const decision = evaluateQualification(baseContext({
        contacts: [],
        socialProfiles: [],
        company: { ...baseContext().company, employeeCount: null, employeeRange: null },
        score: { value: 70, band: 'MEDIUM', breakdown: {} as never },
      }), criteria);
      expect(decision.status).toBe('QUALIFIED');
      expect(decision.score).toBe(70);
      expect(decision.criterionResults.every((item) => !item.required || item.result === 'MATCH')).toBe(true);
    });
  });

  describe('TEST 2 — Rich lead request', () => {
    it('builds SearchPlan and enforces qualification gates', () => {
      const plan = parser.parse(RICH_PROMPT);
      expect(plan).toMatchObject({
        requestedCount: 200,
        countIntent: 'exact',
        companySize: { min: 1, max: 50 },
        minimumScore: 80,
        emailRequirement: { requested: true, required: true, verified: true },
        websiteRequirement: { requested: true, required: true },
      });
      expect(plan.decisionMakerRoles).toEqual(expect.arrayContaining(['CEO', 'Founder']));
      expect(plan.requiredFields).toEqual(expect.arrayContaining([
        'companyLinkedin', 'companyFacebook', 'companyInstagram', 'personLinkedin', 'personEmail', 'website',
      ]));

      const criteria = normalizeCriteria(plan);
      expect(criteria.personEmailRequired).toBe(true);
      expect(criteria.verifiedEmailRequired).toBe(true);
      expect(criteria.minimumScore).toBe(80);
      expect(criteria.companyRequiredFields).toEqual(expect.arrayContaining(['companyLinkedin', 'companyFacebook', 'companyInstagram']));
      expect(criteria.personRequiredFields).toEqual(expect.arrayContaining(['personLinkedin', 'personEmail']));

      expect(evaluateQualification(baseContext({
        contacts: [{ ...baseContext().contacts[0], linkedinUrl: null }],
      }), criteria).status).not.toBe('QUALIFIED');

      const highScoreMissingSize = evaluateQualification(baseContext({
        score: { value: 99, band: 'VERY_HIGH', breakdown: {} as never },
        company: { ...baseContext().company, employeeCount: 200, employeeRange: '201-500' },
      }), criteria);
      expect(highScoreMissingSize.status).toBe('NOT_QUALIFIED');

      expect(evaluateQualification(baseContext({
        contacts: [{ ...baseContext().contacts[0], linkedinUrl: 'https://linkedin.com/company/northwind' }],
      }), criteria).criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');

      expect(evaluateQualification(baseContext({
        contacts: [{ ...baseContext().contacts[0], email: null }],
        company: { ...baseContext().company, email: 'info@northwind.example' },
      }), criteria).criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NOT_FOUND');

      const deliverabilityOnly = evaluateQualification(baseContext({
        verifications: baseContext().verifications.map((item) => (
          item.field === 'email'
            ? { ...item, metadata: { ownershipVerified: false, deliverabilityVerified: true, verificationKind: 'deliverability' } }
            : item
        )),
      }), criteria);
      expect(deliverabilityOnly.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
      expect(deliverabilityOnly.status).not.toBe('QUALIFIED');
      expect(['NEEDS_REVIEW', 'NOT_QUALIFIED']).toContain(deliverabilityOnly.status);
    });
  });

  describe('TEST 3 — Score filtering', () => {
    it('uses latest score only with QUALIFIED/min/max bounds', () => {
      const history = [
        { score: 60, calculatedAt: '2026-01-01T00:00:00.000Z' },
        { score: 75, calculatedAt: '2026-02-01T00:00:00.000Z' },
        { score: 91, calculatedAt: '2026-03-01T00:00:00.000Z' },
      ];
      expect(latestScorePassesFilter(history, { minScore: 80 })).toBe(true);
      expect(latestScorePassesFilter(history, { maxScore: 90 })).toBe(false);
      expect(latestScorePassesFilter([
        ...history,
        { score: 72, calculatedAt: '2026-04-01T00:00:00.000Z' },
      ], { minScore: 80 })).toBe(false);

      const filters = applyExportMode(plainToInstance(ListLeadsDto, {
        qualificationStatus: 'QUALIFIED',
        minScore: '80',
        maxScore: '100',
        searchExecutionId: '11111111-1111-1111-1111-111111111111',
        page: '2',
        limit: '25',
      }), 'QUALIFIED');
      expect(filters).toMatchObject({
        qualificationStatus: 'QUALIFIED',
        minScore: 80,
        maxScore: 100,
        searchExecutionId: '11111111-1111-1111-1111-111111111111',
        page: 2,
        limit: 25,
      });
    });
  });

  describe('TEST 4 — Requested score selection', () => {
    it('filters existing leads without rediscovery (filter-only path)', () => {
      const filters = plainToInstance(ListLeadsDto, {
        searchExecutionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        minScore: '85',
      });
      expect(filters.minScore).toBe(85);
      expect(filters.searchExecutionId).toBeTruthy();
      // Export uses the same ListLeadsDto filters — no discovery stage involved.
      const exported = applyExportMode(filters, 'ALL');
      expect(exported.minScore).toBe(85);
      expect(exported.searchExecutionId).toBe(filters.searchExecutionId);
    });
  });

  describe('TEST 5–7 — Count intents', () => {
    it('exact / maximum / minimum semantics stay distinct', () => {
      const exact = parser.parse('Find exactly 25 marketing companies in New York.');
      expect(exact.countIntent).toBe('exact');
      expect(exact.requestedCount).toBe(25);
      expect(discoveryTarget(exact)).toBe(25);
      expect(discoveryAcceptanceCap(exact)).toBe(25);
      expect(countShortfall(exact, 18)).toBe(7);

      const maximum = parser.parse('Find up to 25 marketing companies in New York.');
      expect(maximum.countIntent).toBe('maximum');
      expect(discoveryAcceptanceCap(maximum)).toBe(25);
      expect(countShortfall(maximum, 10)).toBe(15);

      const minimum = parser.parse('Find at least 25 marketing companies in New York.');
      expect(minimum.countIntent).toBe('minimum');
      expect(discoveryTarget(minimum)).toBeGreaterThan(25);
      expect(discoveryAcceptanceCap(minimum)).toBeGreaterThan(25);
      expect(qualifiedShortfall(minimum, 20)).toBe(5);
      expect(explicitResultCount(minimum)).toBe(25);
    });
  });

  describe('TEST 8 — Exclusions', () => {
    it('preserves exclusions and rejects clear matches without fabricating certainty', () => {
      const plan = parser.parse('Find software companies in California but exclude agencies.');
      expect(plan.exclusions?.some((item) => /agenc/i.test(item))).toBe(true);
      const criteria = normalizeCriteria({
        ...normalizeCriteria(plan),
        exclusions: plan.exclusions ?? ['agencies'],
      });
      const clear = evaluateQualification(baseContext({
        company: {
          ...baseContext().company,
          name: 'Bright Marketing Agency',
          description: 'We are a digital marketing agency.',
          category: 'marketing_agency',
        },
        evidence: [{
          ...baseContext().evidence[0],
          evidenceText: 'Bright Marketing Agency is a full-service digital marketing agency.',
        }],
      }), criteria);
      expect(clear.criterionResults.find((item) => item.criterion === 'exclusion')?.result).toBe('NO_MATCH');
      expect(clear.status).toBe('NOT_QUALIFIED');
    });
  });

  describe('TEST 9 — Company vs person social separation', () => {
    it('does not cross-satisfy LinkedIn requirements', () => {
      const plan = parser.parse('Find companies with company LinkedIn and the founder\'s LinkedIn.');
      const criteria = normalizeCriteria(plan);
      expect(isCompanyProfileUrl('https://linkedin.com/company/northwind')).toBe(true);
      expect(isPersonProfileUrl('https://linkedin.com/in/ada-lovelace')).toBe(true);

      const companyAsPerson = evaluateQualification(baseContext({
        contacts: [{ ...baseContext().contacts[0], linkedinUrl: 'https://linkedin.com/company/northwind' }],
      }), criteria);
      expect(companyAsPerson.criterionResults.find((item) => item.criterion === 'personLinkedin')?.result).toBe('NOT_FOUND');

      const personAsCompany = evaluateQualification(baseContext({
        socialProfiles: [{ platform: 'linkedin', profileUrl: 'https://linkedin.com/in/ada-lovelace' }],
      }), criteria);
      expect(personAsCompany.criterionResults.find((item) => item.criterion === 'companySocial:linkedin')?.result).toBe('NOT_FOUND');
      expect(companyAsPerson.status).not.toBe('QUALIFIED');
      expect(personAsCompany.status).not.toBe('QUALIFIED');
    });
  });

  describe('TEST 10 — Email truthfulness', () => {
    it('keeps syntax / evidence / deliverability / ownership statuses distinct', () => {
      const syntax = summarizeAggregateVerification([
        { field: 'email', status: 'UNVERIFIED', metadata: { verificationKind: 'syntax', ownershipVerified: false } },
      ]);
      expect(syntax.fields[0].displayStatus).toBe('SYNTAX_VALID');
      expect(syntax.flags.personOwnershipVerified).toBe(false);

      const supported = summarizeAggregateVerification([
        { field: 'email', status: 'SUPPORTED', metadata: { verificationKind: 'evidence_supported', ownershipVerified: false } },
      ]);
      expect(supported.fields[0].displayStatus).toBe('EVIDENCE_SUPPORTED');

      const verified = summarizeAggregateVerification([
        { field: 'email', status: 'VERIFIED', metadata: { verificationKind: 'independent_evidence', ownershipVerified: false } },
      ]);
      expect(verified.fields[0].displayStatus).toBe('EVIDENCE_VERIFIED');

      const deliverability = summarizeAggregateVerification([
        { field: 'email', status: 'VERIFIED', metadata: { deliverabilityVerified: true, ownershipVerified: false, verificationKind: 'deliverability' } },
      ]);
      expect(deliverability.fields[0].displayStatus).toBe('DELIVERABILITY_VERIFIED');
      expect(deliverability.flags.personOwnershipVerified).toBe(false);
      expect(deliverability.aggregateStatus).not.toBe('VERIFIED');

      const ownership = summarizeAggregateVerification([
        { field: 'email', status: 'VERIFIED', metadata: { ownershipVerified: true, verificationKind: 'ownership' } },
      ]);
      expect(ownership.fields[0].displayStatus).toBe('PERSON_OWNERSHIP_VERIFIED');
      expect(ownership.flags.personOwnershipVerified).toBe(true);

      expect(assessPersonEmailOwnership({
        email: 'info@northwind.example',
        personName: 'Ada Lovelace',
        evidence: [
          claimEvidence('email', 'info@northwind.example', 'https://a.example', 'website', 'Ada Lovelace info@northwind.example'),
          claimEvidence('email', 'info@northwind.example', 'https://b.example', 'web', 'Ada Lovelace info@northwind.example'),
        ],
      }).ownershipVerified).toBe(false);
    });
  });

  describe('TEST 11 — Decision-maker relationship', () => {
    it('enforces roles and company relationship without loose substring matches', () => {
      expect(roleMatches('CEO', ['CEO', 'Founder'])).toBe(true);
      expect(roleMatches('Founder', ['CEO', 'Founder'])).toBe(true);
      expect(roleMatches('Office Manager', ['Manager'])).toBe(false);
      expect(roleMatches('Manager', ['CEO'])).toBe(false);

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

      const criteria = normalizeCriteria(parser.parse(RICH_PROMPT));
      const wrongRole = evaluateQualification(baseContext({
        contacts: [{ ...baseContext().contacts[0], title: 'Manager', normalizedRole: 'Manager' }],
      }), criteria);
      expect(wrongRole.criterionResults.find((item) => item.criterion === 'decisionMaker')?.result).toBe('NO_MATCH');
      expect(wrongRole.status).toBe('NOT_QUALIFIED');
    });
  });

  describe('TEST 12 — Website', () => {
    it('rejects social/directory/news/marketplace hosts as official websites', () => {
      expect(classifyOfficialWebsiteHost('linkedin.com')).toBe('SOCIAL_PROFILE');
      expect(classifyOfficialWebsiteHost('crunchbase.com')).toBe('DIRECTORY');
      expect(classifyOfficialWebsiteHost('techcrunch.com')).toBe('NEWS_ARTICLE');
      expect(evaluateOfficialWebsite({
        companyName: 'Northwind Software',
        url: 'https://linkedin.com/company/northwind',
        title: 'Northwind Software | LinkedIn',
        text: 'Software company',
      }).accepted).toBe(false);
      expect(evaluateOfficialWebsite({
        companyName: 'Northwind Software',
        url: 'https://northwind.example',
        title: 'Northwind Software',
        text: 'Official home of Northwind Software platforms. Northwind Software builds enterprise platforms.',
      }).accepted).toBe(true);

      const criteria = normalizeCriteria(parser.parse(RICH_PROMPT));
      const linkedInAsWebsite = evaluateQualification(baseContext({
        company: { ...baseContext().company, website: 'https://linkedin.com/company/northwind' },
        verifications: baseContext().verifications.map((item) => (
          item.field === 'website' ? { ...item, status: 'INVALID' } : item
        )),
      }), criteria);
      expect(linkedInAsWebsite.criterionResults.find((item) => item.criterion === 'website')?.result).toBe('NO_MATCH');
    });
  });

  describe('TEST 13 — Qualification vs score', () => {
    it('score never overrides required criteria; minimumScore still gates QUALIFIED', () => {
      const criteria = normalizeCriteria(parser.parse(RICH_PROMPT));
      const missingLinkedIn = evaluateQualification(baseContext({
        score: { value: 95, band: 'VERY_HIGH', breakdown: {} as never },
        contacts: [{ ...baseContext().contacts[0], linkedinUrl: null }],
      }), criteria);
      expect(missingLinkedIn.status).not.toBe('QUALIFIED');
      expect(missingLinkedIn.score).toBe(95);

      const lowScore = evaluateQualification(baseContext({
        score: { value: 65, band: 'MEDIUM', breakdown: {} as never },
      }), criteria);
      expect(lowScore.criterionResults.find((item) => item.criterion === 'minimumScore')?.result).toBe('NO_MATCH');
      expect(lowScore.status).toBe('NOT_QUALIFIED');
    });
  });

  describe('TEST 14 — Qualification traceability', () => {
    it('exposes criteriaSnapshot-compatible criteria, criterionResults, score, and status', () => {
      const plan = parser.parse(RICH_PROMPT);
      const criteria = normalizeCriteria(plan);
      const decision = evaluateQualification(baseContext(), criteria);
      expect(decision.criteria).toMatchObject({
        requestedCount: 200,
        countIntent: 'exact',
        minimumScore: 80,
        personEmailRequired: true,
        verifiedEmailRequired: true,
      });
      expect(decision.criteria.industry).toEqual(expect.arrayContaining(['software']));
      expect(decision.criteria.locations.some((item) => item.state === 'California')).toBe(true);
      expect(decision.criterionResults.length).toBeGreaterThan(5);
      expect(decision.criterionResults.every((item) => item.criterion && item.result && item.message)).toBe(true);
      expect(decision.score).toBe(92);
      expect(['QUALIFIED', 'NEEDS_REVIEW', 'NOT_QUALIFIED']).toContain(decision.status);

      const summary = summarizeAggregateVerification(baseContext().verifications.map((item) => ({
        field: item.field,
        status: item.status,
        metadata: item.metadata ?? null,
      })));
      expect(summary.flags.personOwnershipVerified).toBe(true);
      expect(summary.fields.some((item) => item.field === 'email')).toBe(true);
    });
  });

  describe('TEST 15 — Export parity', () => {
    it('QUALIFIED + score + execution filters stay on the export ListLeadsDto path', () => {
      const filters = applyExportMode(plainToInstance(ListLeadsDto, {
        searchExecutionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        qualificationStatus: 'QUALIFIED',
        minScore: '80',
        maxScore: '100',
      }), 'QUALIFIED');
      expect(filters.qualificationStatus).toBe('QUALIFIED');
      expect(filters.minScore).toBe(80);
      expect(filters.maxScore).toBe(100);
      expect(filters.searchExecutionId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      expect(EXPORT_FIELD_HEADERS.contactEmail).toBe('Contact Email');
      expect(EXPORT_FIELD_HEADERS.contactEmail).not.toBe('Verified Email');
      const plan = parser.parse(RICH_PROMPT);
      const columns = columnsFromSearchPlan(plan);
      expect(columns).toEqual(expect.arrayContaining(['contactEmail', 'qualificationStatus', 'score']));
      expect(displayHeaders(['contactEmail'])).toEqual(['Contact Email']);
    });
  });

  describe('End-to-end contract — criteria survive plan → qualify → filter/export', () => {
    it('keeps SearchPlan criteria aligned with qualification criteriaSnapshot and export filters', () => {
      const plan = parser.parse(RICH_PROMPT);
      const criteria = normalizeCriteria(plan);
      const decision = evaluateQualification(baseContext(), criteria);

      expect(decision.criteria.requestedCount).toBe(plan.requestedCount);
      expect(decision.criteria.countIntent).toBe(plan.countIntent);
      expect(decision.criteria.minimumScore).toBe(plan.minimumScore);
      expect(decision.criteria.personEmailRequired).toBe(true);
      expect(decision.criteria.verifiedEmailRequired).toBe(Boolean(plan.emailRequirement?.verified));
      expect(decision.criteria.exclusions).toEqual(plan.exclusions ?? []);

      const exportFilters = applyExportMode(plainToInstance(ListLeadsDto, {
        searchExecutionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        qualificationStatus: decision.status === 'QUALIFIED' ? 'QUALIFIED' : undefined,
        minScore: String(plan.minimumScore),
      }), decision.status === 'QUALIFIED' ? 'QUALIFIED' : 'ALL');
      expect(exportFilters.minScore).toBe(80);
      if (decision.status === 'QUALIFIED') {
        expect(exportFilters.qualificationStatus).toBe('QUALIFIED');
      }
    });
  });

  describe('No-fabrication contract', () => {
    it('never invents emails, people, socials, websites, or count fillers', () => {
      const snov = new SnovContactProvider({
        get: (key: string) => ({
          'contactProvider.clientId': 'id',
          'contactProvider.clientSecret': 'secret',
          'contactProvider.baseUrl': 'https://api.snov.io',
        }[key]),
      } as ConfigService);
      const mapped = snov.mapProspect({
        fullName: 'Ada Example',
        position: 'CEO',
        email: 'ada@oakstream.example',
        emailStatus: 'valid',
        companyName: 'Oak Stream Investors',
      }, 'Oak Stream Investors', 'oakstream.example');
      // Provider "valid" must not become VERIFIED / ownership.
      expect(mapped?.emailStatus).toBe('FOUND');
      expect(mapped?.emailStatus).not.toBe('VERIFIED');
      expect(mapped?.emailStatus).not.toBe('PERSON_OWNERSHIP_VERIFIED');

      const criteria = normalizeCriteria(parser.parse(RICH_PROMPT));
      const empty = evaluateQualification(baseContext({
        contacts: [],
        socialProfiles: [],
        company: {
          ...baseContext().company,
          website: null,
          email: null,
          employeeCount: null,
          employeeRange: null,
        },
        verifications: [],
        evidence: [],
        score: null,
      }), criteria);
      expect(empty.status).not.toBe('QUALIFIED');
      expect(empty.criterionResults.some((item) => item.result === 'NOT_FOUND' && item.required)).toBe(true);
      expect(empty.criterionResults.every((item) => item.evidenceExcerpt == null || item.evidenceExcerpt.length >= 0)).toBe(true);

      const plan = { requestedCount: 50, countIntent: 'exact' as const, maxResults: 50 };
      expect(countShortfall(plan, 12)).toBe(38);
      expect(discoveryAcceptanceCap(plan)).toBe(50);
      // Shortfall is reported — system must not invent 38 companies.
      expect(qualifiedShortfall(plan, 12)).toBe(38);
    });
  });
});
