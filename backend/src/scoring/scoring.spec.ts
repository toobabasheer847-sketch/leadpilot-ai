import { calculateDeterministicScore, scoreBand } from './scoring.service';

const company = {
  name: 'Example Cash Home Buyers',
  website: 'https://example.test',
  description: 'We buy houses for cash.',
  phone: '555-0100',
  employeeCount: 12,
  employeeRange: null,
  investmentStrategy: 'Fix and flip',
  marketsServed: ['TX'],
  propertyTypes: ['residential'],
};

const contact = {
  fullName: 'John Smith',
  title: 'Founder',
  email: 'john@example.test',
  phone: '555-0101',
  linkedinUrl: 'https://linkedin.com/in/john',
};

describe('deterministic lead scoring', () => {
  it('scores a qualified, well-supported lead positively with an explainable breakdown', () => {
    const result = calculateDeterministicScore(company, contact, { decision: 'QUALIFIED' }, [
      { field: 'companyName', status: 'SUPPORTED', evidenceId: 'e1' },
      { field: 'website', status: 'SUPPORTED', evidenceId: 'e2' },
      { field: 'state', status: 'VERIFIED', evidenceId: 'e3' },
      { field: 'fullName', status: 'SUPPORTED', evidenceId: 'e4' },
      { field: 'title', status: 'SUPPORTED', evidenceId: 'e4' },
      { field: 'linkedin', status: 'SUPPORTED', evidenceId: 'e5' },
      { field: 'email', status: 'SUPPORTED', evidenceId: 'e6' },
    ], [
      { id: 'e1', evidenceType: 'COMPANY_WEBSITE', evidenceText: 'Example Cash Home Buyers', retrievedAt: new Date() },
      { id: 'e2', evidenceType: 'PUBLIC_PROFILE', evidenceText: 'Official website', retrievedAt: new Date() },
      { id: 'e3', evidenceType: 'PUBLIC_RECORD', evidenceText: 'Texas', retrievedAt: new Date() },
      { id: 'e4', evidenceType: 'COMPANY_WEBSITE', evidenceText: 'John Smith Founder', retrievedAt: new Date() },
      { id: 'e5', evidenceType: 'PROFESSIONAL_PROFILE', evidenceText: 'John Smith', retrievedAt: new Date() },
      { id: 'e6', evidenceType: 'COMPANY_WEBSITE', evidenceText: 'We buy houses for cash.', retrievedAt: new Date() },
    ]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.version).toBe('v1');
    expect(result.signals.some((signal) => signal.name === 'acquisition_evidence' && signal.points > 0)).toBe(true);
  });

  it('heavily reduces NOT_QUALIFIED and does not treat insufficient evidence as qualified', () => {
    const notQualified = calculateDeterministicScore(company, null, { decision: 'NOT_QUALIFIED' }, [], []);
    const insufficient = calculateDeterministicScore({ ...company, description: null, website: null, phone: null, employeeCount: null, investmentStrategy: null }, null, { decision: 'INSUFFICIENT_EVIDENCE' }, [], []);
    expect(notQualified.total).toBeLessThan(30);
    expect(insufficient.total).toBeLessThan(20);
  });

  it('penalizes conflicts while preserving missing data as zero-point signals', () => {
    const result = calculateDeterministicScore(company, null, { decision: 'QUALIFIED' }, [
      { field: 'website', status: 'CONFLICT', evidenceId: 'e1' },
      { field: 'email', status: 'NOT_FOUND', evidenceId: null },
    ], []);
    expect(result.signals.find((signal) => signal.name === 'conflicting_evidence')?.points).toBe(-10);
    expect(result.signals.find((signal) => signal.name === 'business_email')).toBeUndefined();
    expect(result.signals.find((signal) => signal.name === 'official_website')?.points).toBeLessThan(0);
  });

  it('reports completeness, source diversity, freshness, score boundaries, and bands', () => {
    const result = calculateDeterministicScore(company, contact, null, [], [
      { id: 'e1', evidenceType: 'COMPANY_WEBSITE', evidenceText: 'buy houses', retrievedAt: new Date() },
      { id: 'e2', evidenceType: 'PUBLIC_RECORD', evidenceText: 'Texas', retrievedAt: new Date() },
    ]);
    expect(result.completenessPercentage).toBeGreaterThan(0);
    expect(result.sourceTypes).toEqual(['COMPANY_WEBSITE', 'PUBLIC_RECORD']);
    expect(result.signals.find((signal) => signal.name === 'evidence_freshness')?.points).toBe(3);
    expect(scoreBand(0)).toBe('LOW');
    expect(scoreBand(39)).toBe('LOW');
    expect(scoreBand(40)).toBe('MEDIUM');
    expect(scoreBand(70)).toBe('HIGH');
    expect(scoreBand(85)).toBe('VERY_HIGH');
  });
});
