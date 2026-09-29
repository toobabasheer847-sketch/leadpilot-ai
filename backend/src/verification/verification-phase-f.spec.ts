import { ConfigService } from '@nestjs/config';
import { ConflictEngineService } from './conflict/conflict-engine.service';
import { EmailVerificationProvider } from './providers/email/email-verification.provider';
import { assessPersonEmailOwnership, independentSourceKey, registrableDomain } from './utils/email-ownership';
import { isGenericBusinessEmail } from './utils/generic-email';
import type { VerificationEvidence } from './types/verification.types';
import { evaluateQualification, normalizeCriteria } from '../qualification/engine/qualification-engine';
import type { QualificationContext } from '../qualification/types/qualification.types';
import { SearchPlanParser } from '../search/parsers/search-plan.parser';

function claimEvidence(
  field: string,
  value: string,
  sourceUrl: string,
  provider: string,
  evidenceText?: string,
): VerificationEvidence {
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
      title: 'CEO',
      normalizedRole: 'CEO',
      companyRelationship: 'current',
      email: 'ada@northwind.example',
      phone: null,
      linkedinUrl: null,
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      verificationStatus: 'SUPPORTED',
    }],
    evidence: [],
    verifications: [
      { field: 'companyName', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
      { field: 'website', status: 'SUPPORTED', fieldValue: 'https://northwind.example', evidenceId: 'ev-1' },
      { field: 'state', status: 'VERIFIED', fieldValue: 'California', evidenceId: 'ev-1' },
      { field: 'fullName', status: 'SUPPORTED', fieldValue: 'Ada Founder', evidenceId: 'ev-1' },
      { field: 'title', status: 'SUPPORTED', fieldValue: 'Founder', evidenceId: 'ev-1' },
      { field: 'companyRelationship', status: 'SUPPORTED', fieldValue: 'Northwind Software', evidenceId: 'ev-1' },
    ],
    conflicts: [],
    classification: null,
    score: null,
    ...overrides,
  };
}

const verifiedPersonEmailPlan = {
  industry: ['software'],
  leadTypes: [] as string[],
  locations: [{ country: 'US', state: 'California' }],
  companyFields: [] as string[],
  personFields: ['email'],
  decisionMakerRoles: ['CEO', 'Founder'],
  requiredRoles: ['CEO', 'Founder'],
  emailRequirement: { requested: true, required: true, verified: true },
  verificationRequirement: { requested: true, required: true, fields: ['email'] },
  requiredFields: [] as string[],
  unresolvedCriteria: [] as Array<{ text: string; reason: string }>,
};

describe('Phase F truthful email verification semantics', () => {
  const engine = new ConflictEngineService();

  it('A: syntax-valid email stays UNVERIFIED / syntax with ownershipVerified=false', async () => {
    const result = await new EmailVerificationProvider().verify({
      field: 'email',
      value: 'ada@northwind.example',
      evidence: [],
    });
    expect(result.status).toBe('UNVERIFIED');
    expect(result.metadata?.verificationKind).toBe('syntax');
    expect(result.metadata?.ownershipVerified).toBe(false);
    expect(result.metadata?.deliverabilityVerified).toBe(false);
  });

  it('B: one-source email evidence is SUPPORTED with ownershipVerified=false', () => {
    const result = engine.evaluateField({
      field: 'email',
      value: 'ada@northwind.example',
      evidence: [claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'Ada Founder — ada@northwind.example')],
    }, () => 1);
    expect(result.status).toBe('SUPPORTED');
    expect(result.metadata?.ownershipVerified).toBe(false);
    expect(result.metadata?.verificationKind).toBe('evidence_supported');
    const ownership = assessPersonEmailOwnership({
      email: 'ada@northwind.example',
      personName: 'Ada Founder',
      evidence: [claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'Ada Founder — ada@northwind.example')],
      evidenceStatus: 'SUPPORTED',
    });
    expect(ownership.ownershipVerified).toBe(false);
    expect(ownership.ownershipSourceCount).toBe(1);
  });

  it('C: two genuinely independent sources linking person + email can set ownershipVerified', () => {
    const evidence = [
      claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'Ada Founder, CEO. Email ada@northwind.example'),
      claimEvidence('email', 'ada@northwind.example', 'https://news.example/profile', 'web_search', 'Ada Founder can be reached at ada@northwind.example'),
    ];
    const result = engine.evaluateField({ field: 'email', value: 'ada@northwind.example', evidence }, () => 1);
    expect(result.status).toBe('VERIFIED');
    expect(result.metadata?.ownershipVerified).toBe(false);
    const ownership = assessPersonEmailOwnership({
      email: 'ada@northwind.example',
      personName: 'Ada Founder',
      evidence,
      evidenceStatus: result.status,
    });
    expect(ownership.ownershipVerified).toBe(true);
    expect(ownership.ownershipSourceCount).toBeGreaterThanOrEqual(2);
    expect(ownership.verificationKind).toBe('ownership');
  });

  it('D: ZeroBounce valid sets deliverabilityVerified=true and ownershipVerified=false', async () => {
    const outbound = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'valid', sub_status: '' }),
      }),
    };
    const provider = new EmailVerificationProvider(
      {
        get: (key: string) => (key === 'verification.zeroBounceApiKey'
          ? 'zb-key'
          : key === 'verification.zeroBounceBaseUrl'
            ? 'https://api.zerobounce.net/v2'
            : 10000),
      } as ConfigService,
      outbound as never,
    );
    const result = await provider.verify({ field: 'email', value: 'ada@northwind.example', evidence: [] });
    expect(result.status).toBe('VERIFIED');
    expect(result.metadata?.deliverabilityVerified).toBe(true);
    expect(result.metadata?.ownershipVerified).toBe(false);
    expect(result.metadata?.verificationKind).toBe('deliverability');
  });

  it('E: ZeroBounce valid company mailbox cannot satisfy required person email', async () => {
    expect(isGenericBusinessEmail('info@northwind.example')).toBe(true);
    const outbound = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'valid', sub_status: '' }),
      }),
    };
    const provider = new EmailVerificationProvider(
      {
        get: (key: string) => (key === 'verification.zeroBounceApiKey' ? 'zb-key' : key === 'verification.zeroBounceBaseUrl' ? 'https://api.zerobounce.net/v2' : 10000),
      } as ConfigService,
      outbound as never,
    );
    // Provider short-circuits generic mailboxes before ZeroBounce.
    const zb = await provider.verify({ field: 'email', value: 'info@northwind.example', evidence: [] });
    expect(zb.metadata?.genericMailbox).toBe(true);
    expect(zb.metadata?.ownershipVerified).toBe(false);

    const criteria = normalizeCriteria(verifiedPersonEmailPlan);
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, email: 'info@northwind.example' },
      contacts: [{ ...baseContext().contacts[0], email: null }],
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'VERIFIED',
        fieldValue: 'info@northwind.example',
        evidenceId: null,
        metadata: { deliverabilityVerified: true, ownershipVerified: false, verificationKind: 'deliverability' },
      }]),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('F: person requested + company email only → NOT_FOUND / not QUALIFIED', () => {
    const criteria = normalizeCriteria(verifiedPersonEmailPlan);
    const decision = evaluateQualification(baseContext({
      company: { ...baseContext().company, email: 'office@northwind.example' },
      contacts: [{ ...baseContext().contacts[0], email: null }],
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NOT_FOUND');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('G: verified person email + syntax-only cannot qualify', () => {
    const criteria = normalizeCriteria(verifiedPersonEmailPlan);
    const decision = evaluateQualification(baseContext({
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'UNVERIFIED',
        fieldValue: 'ada@northwind.example',
        evidenceId: null,
        metadata: { ownershipVerified: false, deliverabilityVerified: false, verificationKind: 'syntax' },
      }]),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).toBe('NEEDS_REVIEW');
  });

  it('H: verified person email + SUPPORTED cannot qualify as ownership verified', () => {
    const criteria = normalizeCriteria(verifiedPersonEmailPlan);
    const decision = evaluateQualification(baseContext({
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'SUPPORTED',
        fieldValue: 'ada@northwind.example',
        evidenceId: 'ev-1',
        metadata: { ownershipVerified: false, verificationKind: 'evidence_supported', sourceCount: 1 },
      }]),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('I: verified person email + deliverability only cannot qualify as ownership verified', () => {
    const criteria = normalizeCriteria(verifiedPersonEmailPlan);
    const decision = evaluateQualification(baseContext({
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'VERIFIED',
        fieldValue: 'ada@northwind.example',
        evidenceId: null,
        metadata: { ownershipVerified: false, deliverabilityVerified: true, verificationKind: 'deliverability' },
      }]),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
    expect(decision.status).not.toBe('QUALIFIED');
  });

  it('J: conflicting person/email evidence stays NEEDS_REVIEW with no fabricated winner', () => {
    const result = engine.evaluateField({
      field: 'email',
      value: 'ada@northwind.example',
      evidence: [
        claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'Ada Founder ada@northwind.example'),
        claimEvidence('email', 'bob@northwind.example', 'https://news.example/article', 'web_search', 'Bob Other bob@northwind.example'),
      ],
    }, () => 1);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.conflict).toBeTruthy();
    expect(result.metadata?.ownershipVerified).toBe(false);

    const criteria = normalizeCriteria(verifiedPersonEmailPlan);
    const decision = evaluateQualification(baseContext({
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'NEEDS_REVIEW',
        fieldValue: 'ada@northwind.example',
        evidenceId: null,
        metadata: { ownershipVerified: false, requiresReview: true },
      }]),
    }), criteria);
    expect(decision.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('NEEDS_REVIEW');
  });

  it('K: same registrable domain with multiple pages does not count as independent ownership sources', () => {
    expect(registrableDomain('https://northwind.example/team')).toBe('northwind.example');
    expect(registrableDomain('https://www.northwind.example/about')).toBe('northwind.example');
    expect(independentSourceKey({
      provider: 'website',
      sourceUrl: 'https://northwind.example/team',
    })).toBe(independentSourceKey({
      provider: 'website',
      sourceUrl: 'https://www.northwind.example/about',
    }));

    const evidence = [
      claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/team', 'website', 'Ada Founder ada@northwind.example'),
      claimEvidence('email', 'ada@northwind.example', 'https://northwind.example/about', 'website', 'Ada Founder contact ada@northwind.example'),
      claimEvidence('email', 'ada@northwind.example', 'https://www.northwind.example/leadership', 'website', 'Ada Founder — ada@northwind.example'),
    ];
    const result = engine.evaluateField({ field: 'email', value: 'ada@northwind.example', evidence }, () => 1);
    expect(result.status).toBe('SUPPORTED');
    expect(result.metadata?.sourceCount).toBe(1);
    const ownership = assessPersonEmailOwnership({
      email: 'ada@northwind.example',
      personName: 'Ada Founder',
      evidence,
      evidenceStatus: 'SUPPORTED',
    });
    expect(ownership.ownershipVerified).toBe(false);
    expect(ownership.ownershipSourceCount).toBe(1);
  });

  it('L: Phase A–E regression — planner still parses verified person email; ownership can qualify when present', () => {
    const plan = new SearchPlanParser().parse('Find 10 software companies in California with CEO or Founder and verified person email');
    expect(plan.emailRequirement?.verified).toBe(true);
    const criteria = normalizeCriteria(plan);
    expect(criteria.personEmailRequired).toBe(true);
    expect(criteria.verifiedEmailRequired).toBe(true);

    const owned = evaluateQualification(baseContext({
      verifications: baseContext().verifications.concat([{
        field: 'email',
        status: 'VERIFIED',
        fieldValue: 'ada@northwind.example',
        evidenceId: 'ev-1',
        metadata: { ownershipVerified: true, verificationKind: 'ownership', ownershipSourceCount: 2 },
      }]),
    }), criteria);
    expect(owned.criterionResults.find((item) => item.criterion === 'personEmail')?.result).toBe('MATCH');
  });

  it('generic Contact-us mailbox excerpts never become ownership evidence', () => {
    const ownership = assessPersonEmailOwnership({
      email: 'info@northwind.example',
      personName: 'Ada Founder',
      evidence: [
        claimEvidence('email', 'info@northwind.example', 'https://northwind.example/contact', 'website', 'Contact us at info@northwind.example'),
        claimEvidence('email', 'info@northwind.example', 'https://news.example/oak', 'web_search', 'Reach Northwind at info@northwind.example'),
      ],
      evidenceStatus: 'VERIFIED',
    });
    expect(ownership.ownershipVerified).toBe(false);
  });
});
