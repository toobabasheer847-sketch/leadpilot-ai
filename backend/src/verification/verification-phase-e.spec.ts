import { ConflictEngineService } from './conflict/conflict-engine.service';
import { EmailVerificationProvider } from './providers/email/email-verification.provider';
import { companyFieldsForVerification, fieldIsRequiredByPlan, personFieldsForVerification } from './plan-verification-fields';
import { isGenericBusinessEmail } from './utils/generic-email';
import type { VerificationEvidence, VerificationInput } from './types/verification.types';
import { calculateDeterministicScore } from '../scoring/scoring.service';
import type { SearchPlan } from '../search/types/search-plan.types';
import { OutboundRequestService } from '../common/outbound-request.service';
import { ConfigService } from '@nestjs/config';

function evidence(field: string, value: string, sourceUrl: string, provider: string, canonicalUrl = sourceUrl): VerificationEvidence {
  return {
    id: `${provider}-${field}-${value}-${sourceUrl}`,
    sourceUrl,
    canonicalUrl,
    sourceType: provider.includes('snov') ? 'PROVIDER' : provider.includes('web') ? 'PUBLIC_WEB' : 'WEBSITE',
    provider,
    evidenceType: provider.includes('snov') ? 'PROVIDER_SNOV' : 'COMPANY_WEBSITE',
    evidenceText: value,
    metadata: { field, value },
    retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('Phase E multi-source verification & conflict engine', () => {
  const engine = new ConflictEngineService();

  function signal(input: VerificationInput) {
    return engine.evaluateField(input, () => 0);
  }

  it('assigns SUPPORTED for a single authoritative source', () => {
    const result = signal({
      field: 'email',
      value: 'ada@oak.example',
      evidence: [evidence('email', 'ada@oak.example', 'https://oak.example/team', 'official_website', 'https://oak.example')],
    });
    expect(result.status).toBe('SUPPORTED');
    expect(result.provenance?.sourceUrl).toBeTruthy();
  });

  it('assigns VERIFIED when independent sources agree', () => {
    const result = signal({
      field: 'email',
      value: 'ada@oak.example',
      evidence: [
        evidence('email', 'ada@oak.example', 'https://oak.example/team', 'official_website', 'https://oak.example'),
        evidence('email', 'ada@oak.example', 'https://api.snov.io/prospect/1', 'snov', 'https://api.snov.io'),
      ],
    });
    expect(result.status).toBe('VERIFIED');
    expect(result.metadata?.sourceCount).toBe(2);
  });

  it('creates CONFLICT / NEEDS_REVIEW without choosing a winner', () => {
    const result = signal({
      field: 'email',
      value: 'ada@oak.example',
      evidence: [
        evidence('email', 'ada@oak.example', 'https://oak.example/team', 'official_website'),
        evidence('email', 'other@oak.example', 'https://directory.example/oak', 'web_search'),
      ],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.conflict).toEqual(expect.objectContaining({
      fieldName: 'email',
      valueA: 'ada@oak.example',
      valueB: 'other@oak.example',
      status: 'CONFLICT',
      requiresReview: true,
    }));
    const key = engine.conflictIdempotencyKey('org', 'co', 'contact', result.conflict!);
    expect(key).toEqual(engine.conflictIdempotencyKey('org', 'co', 'contact', result.conflict!));
  });

  it('does not double-count duplicate evidence from the same domain/source', () => {
    const result = signal({
      field: 'title',
      value: 'CEO',
      evidence: [
        evidence('title', 'CEO', 'https://oak.example/team', 'official_website', 'https://oak.example'),
        evidence('title', 'CEO', 'https://oak.example/about', 'official_website', 'https://oak.example'),
        evidence('title', 'CEO', 'https://www.oak.example/leadership', 'official_website', 'https://oak.example'),
      ],
    });
    expect(result.status).toBe('SUPPORTED');
    expect(result.metadata?.sourceCount).toBe(1);
  });

  it('keeps per-field statuses independent (NOT_FOUND does not invent values)', () => {
    expect(signal({ field: 'phone', value: null, evidence: [] }).status).toBe('NOT_FOUND');
    expect(signal({
      field: 'fullName',
      value: 'Ada Example',
      evidence: [evidence('fullName', 'Ada Example', 'https://oak.example/team', 'official_website')],
    }).status).toBe('SUPPORTED');
  });

  it('marks generic mailboxes as company-level only and never person-verified', async () => {
    expect(isGenericBusinessEmail('info@oak.example')).toBe(true);
    expect(isGenericBusinessEmail('ada@oak.example')).toBe(false);
    const provider = new EmailVerificationProvider();
    await expect(provider.verify({ field: 'email', value: 'info@oak.example', evidence: [] })).resolves.toMatchObject({
      status: 'UNVERIFIED',
      metadata: { genericMailbox: true, companyLevelOnly: true },
    });
  });

  it('supports ZeroBounce deliverability upgrades without SMTP probing', async () => {
    const outbound = {
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'valid', sub_status: '' }),
      }),
    } as unknown as OutboundRequestService;
    const config = {
      get: (key: string) => ({
        'verification.zeroBounceApiKey': 'zb-key',
        'verification.zeroBounceBaseUrl': 'https://api.zerobounce.net/v2',
        'verification.zeroBounceTimeoutMs': 1000,
      }[key]),
    } as ConfigService;
    const provider = new EmailVerificationProvider(config, outbound);
    await expect(provider.verify({ field: 'email', value: 'ada@oak.example', evidence: [] })).resolves.toMatchObject({
      status: 'VERIFIED',
      provider: 'zerobounce',
      verificationType: 'PROVIDER_CHECK',
      metadata: { deliverabilityVerified: true },
    });
    expect((outbound as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalled();
  });

  it('respects SearchPlan field selection for company and person verification', () => {
    const plan: SearchPlan = {
      industry: ['software'],
      leadTypes: [],
      locations: [],
      companyFields: ['website'],
      personFields: ['personEmail', 'title'],
      requiredFields: ['website', 'personEmail'],
      unresolvedCriteria: [],
      decisionMakerRoles: ['CEO'],
      emailRequirement: { requested: true, required: true, verified: false },
    };
    expect(companyFieldsForVerification(plan)).toEqual(expect.arrayContaining(['companyName', 'website', 'email']));
    expect(companyFieldsForVerification(plan)).not.toContain('investmentStrategy');
    expect(personFieldsForVerification(plan)).toEqual(expect.arrayContaining(['fullName', 'title', 'email']));
    expect(fieldIsRequiredByPlan(plan, 'website')).toBe(true);
    expect(fieldIsRequiredByPlan(plan, 'email')).toBe(true);
    expect(fieldIsRequiredByPlan(plan, 'investmentStrategy')).toBe(false);
  });

  it('lists verified evidence and conflict flags in score explanations', () => {
    const result = calculateDeterministicScore(
      {
        name: 'Oak',
        website: 'https://oak.example',
        description: null,
        phone: null,
        employeeCount: null,
        employeeRange: null,
        investmentStrategy: null,
        marketsServed: null,
        propertyTypes: null,
      },
      { fullName: 'Ada', title: 'CEO', email: 'ada@oak.example', phone: null, linkedinUrl: null },
      { decision: 'QUALIFIED' },
      [
        { field: 'companyName', status: 'SUPPORTED', evidenceId: 'e1' },
        { field: 'website', status: 'VERIFIED', evidenceId: 'e2' },
        { field: 'email', status: 'NEEDS_REVIEW', evidenceId: 'e3' },
        { field: 'fullName', status: 'SUPPORTED', evidenceId: 'e4' },
      ],
      [{ id: 'e1', evidenceType: 'COMPANY_WEBSITE', evidenceText: 'Oak', retrievedAt: new Date() }],
    );
    expect(result.verifiedEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'website', status: 'VERIFIED' }),
      expect.objectContaining({ field: 'companyName', status: 'SUPPORTED' }),
    ]));
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'email', status: 'NEEDS_REVIEW' }),
    ]));
    expect(result.signals.some((signal) => signal.name === 'verified_evidence_list')).toBe(true);
    expect(result.signals.some((signal) => signal.name === 'conflict_flags')).toBe(true);
  });

  it('models email ladder FOUND → SUPPORTED → VERIFIED without inventing missing emails', () => {
    const foundOnly = signal({
      field: 'email',
      value: 'ada@oak.example',
      evidence: [evidence('email', 'ada@oak.example', 'https://oak.example/team', 'official_website')],
    });
    expect(foundOnly.status).toBe('SUPPORTED');

    const verified = signal({
      field: 'email',
      value: 'ada@oak.example',
      evidence: [
        evidence('email', 'ada@oak.example', 'https://oak.example/team', 'official_website'),
        evidence('email', 'ada@oak.example', 'https://linkedin.com/in/ada', 'web_search'),
      ],
    });
    expect(verified.status).toBe('VERIFIED');

    expect(signal({ field: 'email', value: null, evidence: [] }).status).toBe('NOT_FOUND');
  });
});
