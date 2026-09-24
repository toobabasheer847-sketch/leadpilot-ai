import { VerificationService } from './verification.service';
import type { VerificationEvidence, VerificationInput } from './types/verification.types';

type VerificationInternals = {
  localEvidenceSignal(input: VerificationInput): { status: string; metadata?: Record<string, unknown> };
};

function evidence(value: string, sourceUrl: string, provider: string, canonicalUrl = sourceUrl): VerificationEvidence {
  return {
    id: `${provider}-${value}`,
    sourceUrl,
    canonicalUrl,
    sourceType: 'WEBSITE',
    provider,
    evidenceType: 'COMPANY_WEBSITE',
    evidenceText: value,
    metadata: { field: 'title', value },
    retrievedAt: new Date(),
  };
}

function aggregator() {
  return new VerificationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: () => ({}) } as never,
  ) as unknown as VerificationInternals;
}

describe('verification evidence aggregation', () => {
  it('does not count duplicate copies of one canonical source twice', () => {
    const result = aggregator().localEvidenceSignal({ field: 'title', value: 'Founder', evidence: [evidence('Founder', 'https://company.test/team', 'official_website', 'https://company.test'), evidence('Founder', 'https://company.test/about', 'official_website', 'https://company.test')] });
    expect(result.status).toBe('SUPPORTED');
  });

  it('marks agreement across independent sources as verified', () => {
    const result = aggregator().localEvidenceSignal({ field: 'title', value: 'Founder', evidence: [evidence('Founder', 'https://company.test/team', 'official_website'), evidence('Founder', 'https://directory.test/company', 'licensed_directory')] });
    expect(result.status).toBe('VERIFIED');
  });

  it('preserves conflicting values as conflict instead of selecting one', () => {
    const result = aggregator().localEvidenceSignal({ field: 'title', value: 'Founder', evidence: [evidence('Founder', 'https://company.test/team', 'official_website'), evidence('President', 'https://directory.test/company', 'licensed_directory')] });
    expect(result.status).toBe('CONFLICT');
    expect(result.metadata?.values).toEqual(expect.arrayContaining(['founder', 'president']));
  });

  it('returns NOT_FOUND when the field has no value', () => {
    expect(aggregator().localEvidenceSignal({ field: 'email', value: null, evidence: [] }).status).toBe('NOT_FOUND');
  });
});