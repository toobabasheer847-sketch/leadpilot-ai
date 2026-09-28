import { matchCompanies, matchContacts, electMaster, orderedPair, masterScore } from './matching/matching';
import { mergeCompanyScalars, mergeContactScalars } from './merge/entity-merge';
import { normalizeCompany, normalizeContact, normalizeDomain, normalizePhone, normalizeSocialUrl } from './normalization/normalization';

describe('Phase F plan-aware deduplication & entity resolution', () => {
  const companyA = normalizeCompany({
    id: 'a',
    name: 'ABC Home Buyers, LLC',
    website: 'HTTP://www.abc.example/?utm_source=x',
    phone: '+1 (555) 010-0000',
    googlePlaceId: 'place-1',
    address: '10 Main St.',
    city: 'Dallas',
    state: 'TX',
    email: 'info@abc.example',
    socialUrls: ['https://www.linkedin.com/company/abc/'],
    externalIds: ['place-1'],
    phoneVerified: true,
    emailVerified: true,
    evidenceCount: 4,
    contactCount: 2,
    fieldCompleteness: 5,
    verificationStatus: 'VERIFIED',
  });
  const companyB = normalizeCompany({
    id: 'b',
    name: 'ABC Home Buyers Inc.',
    website: 'https://abc.example',
    phone: '5550100000',
    googlePlaceId: 'place-1',
    address: '10 Main St.',
    city: 'Dallas',
    state: 'TX',
    email: 'hello@abc.example',
    socialUrls: ['http://linkedin.com/company/abc/?ref=copy'],
    externalIds: ['place-1'],
    phoneVerified: true,
    emailVerified: false,
    evidenceCount: 1,
    contactCount: 0,
    fieldCompleteness: 2,
    verificationStatus: 'UNVERIFIED',
  });

  it('normalizes domains, phones, social URLs, and safe legal suffixes', () => {
    expect(normalizeDomain('HTTP://www.Example.com/?utm_source=x')).toBe('example.com');
    expect(normalizePhone('+1 (555) 010-0000')).toBe('5550100000');
    expect(normalizeSocialUrl('http://www.linkedin.com/company/example/?ref=copy')).toBe('https://linkedin.com/company/example');
    expect(companyA.name).toBe('abc home buyers');
  });

  it('auto-merges exact domain / place-id / external-id identity', () => {
    const byDomain = matchCompanies(
      normalizeCompany({ id: 'a', name: 'Oak', website: 'https://oak.example' }),
      normalizeCompany({ id: 'b', name: 'Oak Stream', website: 'https://www.oak.example' }),
    );
    expect(byDomain.status).toBe('AUTO_DUPLICATE');
    expect(byDomain.autoMergeEligible).toBe(true);
    expect(byDomain.signals.some((signal) => signal.type === 'DOMAIN' && signal.matched)).toBe(true);

    const byExternal = matchCompanies(
      normalizeCompany({ id: 'a', name: 'Oak', externalIds: ['osm-123'] }),
      normalizeCompany({ id: 'b', name: 'Different', externalIds: ['osm-123'] }),
    );
    expect(byExternal.status).toBe('AUTO_DUPLICATE');
    expect(byExternal.signals.some((signal) => signal.type === 'EXTERNAL_ID' && signal.matched)).toBe(true);

    const decision = matchCompanies(companyA, companyB);
    expect(decision.matchType).toBe('EXACT_MATCH');
    expect(decision.status).toBe('AUTO_DUPLICATE');
  });

  it('does not match identical names alone', () => {
    const decision = matchCompanies(companyA, normalizeCompany({ id: 'c', name: 'ABC Home Buyers' }));
    expect(decision.matchType).toBe('NO_MATCH');
  });

  it('flags ambiguous name+location matches as NEEDS_REVIEW without forcing a merge', () => {
    const decision = matchCompanies(
      normalizeCompany({ id: 'a', name: 'ABC Home Buyers', city: 'Dallas', state: 'TX' }),
      normalizeCompany({ id: 'b', name: 'ABC Home Buyers', city: 'Dallas', state: 'TX' }),
    );
    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.matchType).toBe('POTENTIAL_DUPLICATE');
    expect(decision.autoMergeEligible).toBe(false);
  });

  it('flags same-name same-location records with conflicting domains', () => {
    const decision = matchCompanies(companyA, normalizeCompany({ id: 'e', name: 'ABC Home Buyers', website: 'https://different.example', city: 'Dallas', state: 'TX' }));
    expect(decision.matchType).toBe('CONFLICT');
    expect(decision.status).toBe('CONFLICT');
  });

  it('auto-merges contacts on verified email, LinkedIn, or same-company name+title', () => {
    const verifiedEmail = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith', email: 'JOHN@example.com', title: 'Founder', emailVerified: true }),
      normalizeContact({ id: 'c2', companyId: 'company-a', fullName: 'John Smith', email: 'john@example.com', title: 'CEO', emailVerified: true }),
    );
    expect(verifiedEmail.status).toBe('AUTO_DUPLICATE');
    expect(verifiedEmail.autoMergeEligible).toBe(true);

    const linkedin = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'Ada', linkedinUrl: 'https://linkedin.com/in/ada' }),
      normalizeContact({ id: 'c2', companyId: 'company-a', fullName: 'Ada Example', linkedinUrl: 'https://www.linkedin.com/in/ada/' }),
    );
    expect(linkedin.status).toBe('AUTO_DUPLICATE');

    const nameTitle = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith', title: 'Founder' }),
      normalizeContact({ id: 'c2', companyId: 'company-a', fullName: 'John Smith', title: 'Founder' }),
    );
    expect(nameTitle.status).toBe('AUTO_DUPLICATE');
  });

  it('requires review for unverified email or name-only contact matches', () => {
    const unverifiedEmail = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith', email: 'john@example.com' }),
      normalizeContact({ id: 'c2', companyId: 'company-a', fullName: 'John Smith', email: 'john@example.com' }),
    );
    expect(unverifiedEmail.status).toBe('NEEDS_REVIEW');
    expect(unverifiedEmail.autoMergeEligible).toBe(false);

    const nameOnly = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith' }),
      normalizeContact({ id: 'c2', companyId: 'company-a', fullName: 'John Smith' }),
    );
    expect(nameOnly.status).toBe('NEEDS_REVIEW');
  });

  it('does not merge contacts across different companies', () => {
    const decision = matchContacts(
      normalizeContact({ id: 'c1', companyId: 'company-a', fullName: 'John Smith', title: 'Founder', email: 'a@x.test', emailVerified: true }),
      normalizeContact({ id: 'c2', companyId: 'company-b', fullName: 'John Smith', title: 'Founder', email: 'a@x.test', emailVerified: true }),
    );
    expect(decision.matchType).toBe('NO_MATCH');
  });

  it('elects the richer verified master and preserves verified fields during scalar merge', () => {
    const masterId = electMaster([
      { id: 'weak', verificationStatus: 'UNVERIFIED', evidenceCount: 1, contactCount: 0, fieldCompleteness: 1 },
      { id: 'strong', verificationStatus: 'VERIFIED', evidenceCount: 5, contactCount: 3, fieldCompleteness: 6 },
    ]);
    expect(masterId).toBe('strong');
    expect(masterScore({ verificationStatus: 'VERIFIED', evidenceCount: 5, fieldCompleteness: 6 })).toBeGreaterThan(
      masterScore({ verificationStatus: 'UNVERIFIED', evidenceCount: 1, fieldCompleteness: 1 }),
    );

    const companyUpdates = mergeCompanyScalars(
      { website: 'https://master.example', phone: '111', email: null, category: null, verificationStatus: 'VERIFIED' },
      { website: 'https://loser.example', phone: '222', email: 'info@loser.example', category: 'software', verificationStatus: 'UNVERIFIED' },
      new Set(['website', 'phone']),
    );
    expect(companyUpdates.website).toBeUndefined();
    expect(companyUpdates.phone).toBeUndefined();
    expect(companyUpdates.email).toBe('info@loser.example');
    expect(companyUpdates.category).toBe('software');

    const contactUpdates = mergeContactScalars(
      { title: 'CEO', email: 'ada@oak.example', phone: null, linkedinUrl: null },
      { title: 'Former CEO', email: 'other@oak.example', phone: '555', linkedinUrl: 'https://linkedin.com/in/ada' },
      new Set(['email', 'title']),
    );
    expect(contactUpdates.title).toBeUndefined();
    expect(contactUpdates.email).toBeUndefined();
    expect(contactUpdates.phone).toBe('555');
    expect(contactUpdates.linkedinUrl).toBe('https://linkedin.com/in/ada');
  });

  it('canonicalizes pair order for idempotent duplicate rows', () => {
    expect(orderedPair('b', 'a')).toEqual(['a', 'b']);
    expect(orderedPair('a', 'b')).toEqual(['a', 'b']);
    expect(orderedPair('a', 'b')).toEqual(orderedPair('b', 'a'));
  });
});
