import { ConfigService } from '@nestjs/config';
import { roleMatches, assessPublicDecisionMaker, extractDecisionMakerTitle } from '../contacts/discovery/public-decision-maker';
import { publicPersonEmail } from '../contacts/extraction/contact-extractor.service';
import { CompanySocialDiscoveryService, publicCompanyProfiles } from '../enrichment/social/company-social-discovery.service';
import { WebsiteNormalizerService } from '../enrichment/website/website-normalizer.service';
import { classifyOfficialWebsiteHost, evaluateOfficialWebsite } from '../enrichment/website/official-website.validator';
import { classificationModeFromPlan } from '../ai/classification/classification-mode';
import { EmailVerificationProvider } from './providers/email/email-verification.provider';
import { SocialVerificationProvider } from './providers/social/social-verification.provider';
import { WebsiteVerificationProvider } from './providers/website/website-verification.provider';
import { ConflictEngineService } from './conflict/conflict-engine.service';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import type { VerificationEvidence } from './types/verification.types';

function claimEvidence(field: string, value: string, sourceUrl: string, provider: string, sourceType: string): VerificationEvidence {
  return {
    id: `${provider}-${field}-${value}`,
    sourceUrl,
    canonicalUrl: sourceUrl,
    evidenceType: 'COMPANY_WEBSITE',
    evidenceText: value,
    metadata: { field, value },
    retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
    provider,
    sourceType,
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
      description: null,
      category: 'software',
      investorType: null,
      employeeCount: null,
      employeeRange: null,
      verificationStatus: 'SUPPORTED',
    },
    socialProfiles: [],
    location: { city: 'San Francisco', state: 'California', country: 'US', postalCode: null },
    contacts: [{
      id: 'contact-1',
      fullName: 'Ada Founder',
      title: 'Founder',
      normalizedRole: 'FOUNDER',
      companyRelationship: 'current',
      email: null,
      phone: null,
      linkedinUrl: null,
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
    ],
    conflicts: [],
    classification: null,
    score: null,
    ...overrides,
  };
}

describe('Phase D verification, evidence, and lead quality', () => {
  it('A: syntax-valid email is not VERIFIED', async () => {
    const result = await new EmailVerificationProvider().verify({ field: 'email', value: 'ceo@northwind.example', evidence: [] });
    expect(result.status).toBe('UNVERIFIED');
    expect(result.metadata?.verificationKind).toBe('syntax');
    expect(result.metadata?.ownershipVerified).toBe(false);
    expect(result.metadata?.deliverabilityVerified).toBe(false);
  });

  it('B: ZeroBounce valid result marks deliverability VERIFIED without ownership claim', async () => {
    const outbound = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'valid', sub_status: '' }),
      }),
    };
    const provider = new EmailVerificationProvider(
      { get: (key: string) => (key === 'verification.zeroBounceApiKey' ? 'zb-key' : key === 'verification.zeroBounceBaseUrl' ? 'https://api.zerobounce.net/v2' : 10000) } as ConfigService,
      outbound as never,
    );
    const result = await provider.verify({ field: 'email', value: 'ada@northwind.example', evidence: [] });
    expect(result.status).toBe('VERIFIED');
    expect(result.provider).toBe('zerobounce');
    expect(result.metadata?.deliverabilityVerified).toBe(true);
    expect(result.metadata?.ownershipVerified).toBe(false);
    expect(result.metadata?.verificationKind).toBe('deliverability');
  });

  it('C: missing ZeroBounce does not invent a VERIFIED claim', async () => {
    const result = await new EmailVerificationProvider({ get: () => undefined } as ConfigService).verify({
      field: 'email',
      value: 'ada@northwind.example',
      evidence: [],
    });
    expect(result.status).toBe('UNVERIFIED');
    expect(result.status).not.toBe('VERIFIED');
  });

  it('D/E: person email satisfies person requirement; company email does not', () => {
    const criteria = normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companyFields: [],
      personFields: ['email'],
      decisionMakerRoles: ['Founder'],
      requiredRoles: ['Founder'],
      emailRequirement: { requested: true, required: true, verified: true },
      verificationRequirement: { requested: true, required: true, fields: ['email'] },
      requiredFields: [],
      unresolvedCriteria: [],
    });
    const companyOnly = evaluateQualification(baseContext({
      company: { ...baseContext().company, email: 'info@northwind.example' },
      contacts: [{ ...baseContext().contacts[0], email: null }],
    }), criteria);
    expect(companyOnly.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NOT_FOUND');
    expect(companyOnly.status).not.toBe('QUALIFIED');

    const withPerson = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], email: 'ada@northwind.example' }],
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'SUPPORTED',
        fieldValue: 'ada@northwind.example',
        evidenceId: 'ev-1',
        metadata: { ownershipVerified: false, verificationKind: 'evidence_supported' },
      }]),
    }), criteria);
    // Phase F: SUPPORTED alone cannot satisfy verified person email.
    expect(withPerson.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');

    const withOwnership = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], email: 'ada@northwind.example' }],
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'VERIFIED',
        fieldValue: 'ada@northwind.example',
        evidenceId: 'ev-1',
        metadata: { ownershipVerified: true, verificationKind: 'ownership', ownershipSourceCount: 2 },
      }]),
    }), criteria);
    expect(withOwnership.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('MATCH');
  });

  it('F: generic company email never becomes person email', () => {
    expect(publicPersonEmail('Reach us at info@northwind.example')).toBeNull();
    expect(publicPersonEmail('Contact sales@northwind.example or support@northwind.example')).toBeNull();
    expect(publicPersonEmail('Email hello@northwind.example')).toBeNull();
    const candidate = assessPublicDecisionMaker('Northwind Software', {
      title: 'Ada Founder, Founder of Northwind Software',
      url: 'https://northwind.example/team',
      snippet: 'Ada Founder, Founder of Northwind Software. Contact info@northwind.example.',
    }, { allowedRoles: ['Founder'] });
    expect(candidate?.email).toBeNull();
  });

  it('G: two independent evidence sources can support VERIFIED', () => {
    const engine = new ConflictEngineService();
    const result = engine.evaluateField({
      field: 'email',
      value: 'ada@northwind.example',
      evidence: [
        claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'WEBSITE'),
        claimEvidence('email', 'ada@northwind.example', 'https://news.example/article', 'web_search', 'WEB_SEARCH'),
      ],
    }, () => 1);
    expect(result.status).toBe('VERIFIED');
    expect(result.metadata?.sourceCount).toBeGreaterThanOrEqual(2);
  });

  it('H: conflicting sources remain NEEDS_REVIEW', () => {
    const engine = new ConflictEngineService();
    const result = engine.evaluateField({
      field: 'email',
      value: 'ada@northwind.example',
      evidence: [
        claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'WEBSITE'),
        claimEvidence('email', 'bob@northwind.example', 'https://news.example/article', 'web_search', 'WEB_SEARCH'),
      ],
    }, () => 1);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.conflict).toBeTruthy();
  });

  it('I: social URL host validation does not claim ownership', async () => {
    const result = await new SocialVerificationProvider().verify({
      field: 'linkedin',
      value: 'https://linkedin.com/in/ada-founder',
      evidence: [],
    });
    expect(result.status).toBe('UNVERIFIED');
    expect(result.metadata?.ownershipVerified).toBe(false);
    expect(result.metadata?.hostValidated).toBe(true);
  });

  it('J: social profile cannot become official website', async () => {
    expect(classifyOfficialWebsiteHost('linkedin.com')).toBe('SOCIAL_PROFILE');
    expect(evaluateOfficialWebsite({
      companyName: 'Northwind Software',
      url: 'https://linkedin.com/company/northwind',
      title: 'Northwind Software',
      text: 'Northwind Software',
    }).accepted).toBe(false);
    const website = await new WebsiteVerificationProvider().verify({
      field: 'website',
      value: 'https://linkedin.com/company/northwind',
      evidence: [],
    });
    expect(website.status).toBe('INVALID');
    expect(website.metadata?.rejectedHostReason).toBe('SOCIAL_PROFILE');
  });

  it('K: wrong-company decision maker is rejected', () => {
    expect(assessPublicDecisionMaker('Northwind Software', {
      title: 'Ada Founder, CEO of Contoso Capital',
      url: 'https://linkedin.com/in/ada',
      snippet: 'Ada Founder is CEO of Contoso Capital.',
    }, { allowedRoles: ['CEO'] })).toBeNull();
  });

  it('L: Office Manager does not satisfy CEO/Founder or bare Manager requests incorrectly', () => {
    expect(extractDecisionMakerTitle('Ada is Office Manager at Northwind Software')).toBe('Office Manager');
    expect(roleMatches('Office Manager', ['CEO', 'Founder'])).toBe(false);
    expect(roleMatches('Office Manager', ['Manager'])).toBe(false);
    expect(roleMatches('Manager', ['Manager'])).toBe(true);
    expect(roleMatches('CEO', ['Chief Executive Officer'])).toBe(true);
    expect(assessPublicDecisionMaker('Northwind Software', {
      title: 'Ada Example - Office Manager - Northwind Software',
      url: 'https://northwind.example/team',
      snippet: 'Ada Example is Office Manager of Northwind Software.',
    }, { allowedRoles: ['CEO', 'Founder'] })).toBeNull();

    const decision = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], title: 'Office Manager', normalizedRole: 'OFFICE_MANAGER' }],
    }), normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companyFields: [],
      requiredRoles: ['CEO', 'Founder'],
      decisionMakerRoles: ['CEO', 'Founder'],
      requiredFields: ['companyName'],
      unresolvedCriteria: [],
    }));
    expect(decision.criterionResults.find((item) => item.criterion === 'decisionMaker')?.result).toBe('NO_MATCH');
  });

  it('M: missing required evidence → NEEDS_REVIEW', () => {
    const decision = evaluateQualification(baseContext({
      contacts: [{ ...baseContext().contacts[0], email: null }],
    }), normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companyFields: [],
      personFields: ['email'],
      requiredRoles: ['Founder'],
      emailRequirement: { requested: true, required: true, verified: true },
      verificationRequirement: { requested: true, required: true, fields: ['email'] },
      requiredFields: [],
      unresolvedCriteria: [],
    }));
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('N: clear category mismatch → NOT_QUALIFIED', () => {
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, category: null },
      evidence: [{
        ...baseContext().evidence[0],
        evidenceText: 'We operate a computer repair and it support help desk.',
      }],
    }), normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companyFields: [],
      requiredRoles: [],
      requiredFields: ['companyName'],
      unresolvedCriteria: [],
    }));
    expect(decision.status).toBe('NOT_QUALIFIED');
    expect(decision.criterionResults.find((item) => item.criterion === 'category')?.result).toBe('NO_MATCH');
  });

  it('O/P: non-investor searches stay company mode; investor searches stay investor mode', () => {
    expect(classificationModeFromPlan({ industry: ['software'], leadTypes: [] })).toBe('company');
    expect(classificationModeFromPlan({ industry: ['saas'], leadTypes: [] })).toBe('company');
    expect(classificationModeFromPlan({ industry: ['restaurant'], leadTypes: [] })).toBe('company');
    expect(classificationModeFromPlan({ industry: ['construction'], leadTypes: [] })).toBe('company');
    expect(classificationModeFromPlan({ industry: ['marketing'], leadTypes: [] })).toBe('company');
    expect(classificationModeFromPlan({ industry: ['real_estate'], leadTypes: ['real_estate_investor'] })).toBe('investor');
  });

  it('Q: missing socials stay NOT_FOUND and HTML discovery does not invent person LinkedIn as company social', () => {
    const social = new CompanySocialDiscoveryService(new WebsiteNormalizerService());
    const urls = social.discover('<a href="https://linkedin.com/in/ada-founder">Ada</a><a href="https://linkedin.com/company/northwind">Company</a>', 'https://northwind.example');
    expect(urls).toEqual(['https://linkedin.com/company/northwind']);
    expect(publicCompanyProfiles('Northwind Software', [{ url: 'https://linkedin.com/in/ada', title: 'Ada', snippet: 'person' }])).toEqual([]);
    const decision = evaluateQualification(baseContext({ socialProfiles: [] }), normalizeCriteria({
      industry: ['software'],
      leadTypes: [],
      locations: [{ country: 'US', state: 'California' }],
      companyFields: [],
      socialPlatforms: ['linkedin', 'facebook'],
      requiredRoles: [],
      requiredFields: ['companyName'],
      unresolvedCriteria: [],
    }));
    expect(decision.criterionResults.filter((item) => item.criterion.startsWith('companySocial:')).every((item) => item.result === 'NOT_FOUND')).toBe(true);
  });
});
