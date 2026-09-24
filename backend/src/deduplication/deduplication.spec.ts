import { matchCompanies, matchContacts } from './matching/matching';
import { normalizeCompany, normalizeContact, normalizeDomain, normalizePhone, normalizeSocialUrl } from './normalization/normalization';

describe('deduplication matching', () => {
  const companyA = normalizeCompany({ id: 'a', name: 'ABC Home Buyers, LLC', website: 'HTTP://www.abc.example/?utm_source=x', phone: '+1 (555) 010-0000', googlePlaceId: 'place-1', address: '10 Main St.', city: 'Dallas', state: 'TX', email: 'info@abc.example', socialUrls: ['https://www.linkedin.com/company/abc/'] });
  const companyB = normalizeCompany({ id: 'b', name: 'ABC Home Buyers Inc.', website: 'https://abc.example', phone: '5550100000', googlePlaceId: 'place-1', address: '10 Main St.', city: 'Dallas', state: 'TX', email: 'hello@abc.example', socialUrls: ['http://linkedin.com/company/abc/?ref=copy'] });

  it('normalizes domains, phones, social URLs, and safe legal suffixes', () => {
    expect(normalizeDomain('HTTP://www.Example.com/?utm_source=x')).toBe('example.com');
    expect(normalizePhone('+1 (555) 010-0000')).toBe('5550100000');
    expect(normalizeSocialUrl('http://www.linkedin.com/company/example/?ref=copy')).toBe('https://linkedin.com/company/example');
    expect(companyA.name).toBe('abc home buyers');
  });

  it('recognizes exact company identity signals as an automatic duplicate', () => {
    const decision = matchCompanies(companyA, companyB);
    expect(decision.matchType).toBe('EXACT_MATCH');
    expect(decision.status).toBe('AUTO_DUPLICATE');
    expect(decision.confidence).toBeGreaterThanOrEqual(0.6);
    expect(decision.signals.some((signal) => signal.type === 'DOMAIN' && signal.matched)).toBe(true);
  });

  it('does not match identical names alone', () => {
    const decision = matchCompanies(companyA, normalizeCompany({ id: 'c', name: 'ABC Home Buyers' }));
    expect(decision.matchType).toBe('NO_MATCH');
    expect(decision.status).toBe('PENDING');
  });

  it('does not match different domains in different locations', () => {
    const decision = matchCompanies(companyA, normalizeCompany({ id: 'd', name: 'ABC Home Buyers', website: 'https://different.example', city: 'Houston', state: 'TX' }));
    expect(decision.matchType).toBe('NO_MATCH');
  });

  it('flags same-name same-location records with conflicting domains', () => {
    const decision = matchCompanies(companyA, normalizeCompany({ id: 'e', name: 'ABC Home Buyers', website: 'https://different.example', city: 'Dallas', state: 'TX' }));
    expect(decision.matchType).toBe('CONFLICT');
    expect(decision.status).toBe('CONFLICT');
  });

  it('requires more than a shared contact name', () => {
    const decision = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith', title: 'Founder' }),
      normalizeContact({ id: 'c2', companyId: 'company-b', fullName: 'John Smith', title: 'Founder' }),
    );
    expect(decision.matchType).toBe('NO_MATCH');
  });

  it('recognizes exact contact email and same-company identity', () => {
    const decision = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith', email: 'JOHN@example.com', title: 'Founder' }),
      normalizeContact({ id: 'c2', companyId: 'company-a', fullName: 'John Smith', email: 'john@example.com', title: 'Founder' }),
    );
    expect(decision.status).toBe('AUTO_DUPLICATE');
    expect(decision.signals.find((signal) => signal.type === 'EMAIL')?.matched).toBe(true);
  });
});
