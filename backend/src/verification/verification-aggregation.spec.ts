import { ConflictEngineService } from './conflict/conflict-engine.service';
import { CrossSourceEntityMatcherService } from './matching/cross-source-entity-matcher.service';
import type { VerificationEvidence, VerificationInput } from './types/verification.types';

function evidence(value: string, sourceUrl: string, provider: string, canonicalUrl = sourceUrl): VerificationEvidence {
  return {
    id: `${provider}-${value}-${sourceUrl}`,
    sourceUrl,
    canonicalUrl,
    sourceType: 'WEBSITE',
    provider,
    evidenceType: 'COMPANY_WEBSITE',
    evidenceText: value,
    metadata: { field: 'title', value },
    retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('verification evidence aggregation', () => {
  const engine = new ConflictEngineService();

  function signal(input: VerificationInput) {
    return engine.evaluateField(input, () => 0);
  }

  it('does not count duplicate copies of one canonical source twice', () => {
    const result = signal({
      field: 'title',
      value: 'Founder',
      evidence: [
        evidence('Founder', 'https://company.test/team', 'official_website', 'https://company.test'),
        evidence('Founder', 'https://company.test/about', 'official_website', 'https://company.test'),
      ],
    });
    expect(result.status).toBe('SUPPORTED');
  });

  it('marks agreement across independent sources as verified', () => {
    const result = signal({
      field: 'title',
      value: 'Founder',
      evidence: [
        evidence('Founder', 'https://company.test/team', 'official_website'),
        evidence('Founder', 'https://directory.test/company', 'licensed_directory'),
      ],
    });
    expect(result.status).toBe('VERIFIED');
    expect(result.provenance?.sourceUrl).toBeTruthy();
  });

  it('preserves conflicting values as needs review instead of selecting one', () => {
    const result = signal({
      field: 'title',
      value: 'Founder',
      evidence: [
        evidence('Founder', 'https://company.test/team', 'official_website'),
        evidence('President', 'https://directory.test/company', 'licensed_directory'),
      ],
    });
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.conflict).toEqual(expect.objectContaining({
      fieldName: 'title',
      valueA: 'Founder',
      valueB: 'President',
      status: 'CONFLICT',
      requiresReview: true,
    }));
    expect(result.metadata?.values).toEqual(expect.arrayContaining(['founder', 'president']));
  });

  it('returns NOT_FOUND when the field has no value', () => {
    expect(signal({ field: 'email', value: null, evidence: [] }).status).toBe('NOT_FOUND');
  });
});

describe('cross-source entity matching', () => {
  const matcher = new CrossSourceEntityMatcherService(new ConflictEngineService());

  it('collapses duplicate source urls and matches agreeing sources', () => {
    const result = matcher.match([
      { sourceRecordId: '1', sourceType: 'google_places', sourceUrl: 'https://maps.example/a', retrievedAt: new Date(), name: 'Acme Capital', website: 'https://acme.test', phone: '555-0100' },
      { sourceRecordId: '2', sourceType: 'google_places', sourceUrl: 'https://maps.example/a', retrievedAt: new Date(), name: 'Acme Capital', website: 'https://acme.test', phone: '555-0100' },
      { sourceRecordId: '3', sourceType: 'website', sourceUrl: 'https://acme.test/about', retrievedAt: new Date(), name: 'Acme Capital', website: 'https://www.acme.test', phone: '(555) 0100' },
    ]);
    expect(result.sameEntity).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.signals).toEqual(expect.arrayContaining(['matching company name', 'matching website', 'matching phone']));
  });

  it('stores identity conflicts without choosing a winner', () => {
    const result = matcher.match([
      { sourceRecordId: '1', sourceType: 'google_places', sourceUrl: 'https://maps.example/a', retrievedAt: new Date(), name: 'Acme Capital', website: 'https://acme.test', phone: '555-0100' },
      { sourceRecordId: '2', sourceType: 'directory', sourceUrl: 'https://directory.example/b', retrievedAt: new Date(), name: 'Beta Holdings', website: 'https://beta.test', phone: '555-9999' },
    ]);
    expect(result.sameEntity).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.every((conflict) => conflict.status === 'CONFLICT' && conflict.requiresReview)).toBe(true);
  });
});
