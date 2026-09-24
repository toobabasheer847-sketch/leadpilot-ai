import { contactAccessAllowed, canonicalSourceUrl, evaluateContactQuality, normalizeContactPhone, ContactQualityInput } from './contact-quality.engine';

const roles = ['CEO', 'FOUNDER', 'CO_FOUNDER', 'PRESIDENT', 'OWNER', 'MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'MANAGER'];
const now = '2026-09-24T12:00:00.000Z';

function evidence(overrides: Partial<ContactQualityInput['evidence'][number]>): ContactQualityInput['evidence'][number] {
  return {
    id: 'evidence-1',
    field: 'title',
    value: 'Founder',
    sourceType: 'WEBSITE',
    sourceUrl: 'https://fixture-northwind.test/about',
    excerpt: 'Ada Example is Founder of Fixture Northwind Buyers.',
    retrievedAt: now,
    ...overrides,
  };
}

function input(overrides: Partial<ContactQualityInput> = {}): ContactQualityInput {
  return {
    contact: {
      id: 'contact-1',
      fullName: 'Ada Example',
      title: 'Founder',
      email: null,
      phone: null,
      linkedinUrl: null,
      facebookUrl: null,
      instagramUrl: null,
      youtubeUrl: null,
      companyRelationship: 'Fixture Northwind Buyers',
      createdAt: '2026-09-01T00:00:00.000Z',
      ...overrides.contact,
    },
    company: { id: 'company-1', name: 'Fixture Northwind Buyers', website: 'https://fixture-northwind.test', phone: '+14155550199', ...overrides.company },
    evidence: overrides.evidence ?? [evidence({})],
    peers: overrides.peers ?? [],
    targetRoles: overrides.targetRoles ?? roles,
    reverifyAfterDays: overrides.reverifyAfterDays ?? 30,
    now,
  };
}

describe('contact quality engine', () => {
  it('does not treat a similar name as the same person or as company identity', () => {
    const result = evaluateContactQuality(input({
      evidence: [evidence({ excerpt: 'Jon Example works nearby.', sourceUrl: 'https://unrelated.test/story', field: 'fullName', value: 'Jon Example' })],
      peers: [{ id: 'contact-2', fullName: 'Jon Example', email: null, phone: null, linkedinUrl: null, title: 'Founder' }],
    }));
    expect(result.identityStatus).toBe('UNVERIFIED');
    expect(result.duplicateStatus).toBe('NONE');
    expect(result.duplicateContactId).toBeNull();
  });

  it('matches a configured role exactly and does not treat every manager title as that role', () => {
    const founder = evaluateContactQuality(input());
    const office = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Office Manager', email: null, phone: null, linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      evidence: [evidence({ value: 'Office Manager', excerpt: 'Ada Example is Office Manager of Fixture Northwind Buyers.' })],
    }));
    expect(founder.role.matchedRole).toBe('FOUNDER');
    expect(founder.role.storedTitle).toBe('Founder');
    expect(office.role.matchedRole).toBeNull();
  });

  it('flags an exact identifier overlap for review and does not merge the records', () => {
    const result = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: 'ada.example@fixture-northwind.test', phone: null, linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      peers: [{ id: 'contact-2', fullName: 'Ada Example', email: 'ada.example@fixture-northwind.test', phone: null, linkedinUrl: null, title: 'Founder' }],
    }));
    expect(result.duplicateStatus).toBe('NEEDS_REVIEW');
    expect(result.duplicateContactId).toBe('contact-2');
    expect(result).not.toHaveProperty('canonicalContactId');
  });

  it('does not verify an email from the company domain alone and leaves a missing email as not found', () => {
    const domainOnly = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: 'ada.example@fixture-northwind.test', phone: null, linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      evidence: [evidence({ field: 'email', value: 'ada.example@fixture-northwind.test', excerpt: 'General inbox ada.example@fixture-northwind.test.' })],
    }));
    const missing = evaluateContactQuality(input());
    expect(domainOnly.fields.email.status).toBe('UNVERIFIED');
    expect(domainOnly.fields.email.ownershipVerified).toBe(false);
    expect(missing.fields.email.status).toBe('NOT_FOUND');
    expect(missing.fields.email.value).toBeNull();
  });

  it('supports an email only when evidence links it to the person', () => {
    const result = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: 'ada.example@fixture-northwind.test', phone: null, linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      evidence: [evidence({ field: 'email', value: 'ada.example@fixture-northwind.test', excerpt: 'Ada Example at Fixture Northwind Buyers uses ada.example@fixture-northwind.test.' })],
    }));
    expect(result.fields.email.status).toBe('SUPPORTED');
    expect(result.fields.email.ownershipVerified).toBe(true);
  });

  it('normalizes phone numbers without inventing a country code and separates company phones', () => {
    expect(normalizeContactPhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizeContactPhone('(415) 555-0100')).toBe('4155550100');
    const companyPhone = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: null, phone: '+14155550199', linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      evidence: [evidence({ field: 'phone', value: '+1 415 555 0199', excerpt: 'Ada Example of Fixture Northwind Buyers. Call us at +1 415 555 0199.' })],
    }));
    const personal = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: null, phone: '+14155550100', linkedinUrl: null, facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      evidence: [evidence({ field: 'phone', value: '+14155550100', excerpt: 'Ada Example can be reached at +14155550100.' })],
    }));
    expect(companyPhone.fields.phone.status).toBe('UNVERIFIED');
    expect(companyPhone.fields.phone.phoneKind).toBe('COMPANY_PHONE');
    expect(personal.fields.phone.phoneKind).toBe('PERSONAL_PUBLIC_PHONE');
    expect(personal.fields.phone.status).toBe('SUPPORTED');
  });

  it('leaves a social profile unverified until evidence links it to the person and company', () => {
    const unverified = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: null, phone: null, linkedinUrl: 'https://www.linkedin.com/in/ada-example', facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
    }));
    const supported = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: null, phone: null, linkedinUrl: 'https://www.linkedin.com/in/ada-example', facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
      evidence: [
        evidence({}),
        evidence({ id: 'evidence-social', field: 'profileUrl', value: 'https://www.linkedin.com/in/ada-example', excerpt: 'Ada Example, Founder of Fixture Northwind Buyers. Profile https://www.linkedin.com/in/ada-example.' }),
      ],
    }));
    expect(unverified.fields.linkedin.status).toBe('UNVERIFIED');
    expect(unverified.fields.facebook.status).toBe('NOT_FOUND');
    expect(unverified.fields.instagram.status).toBe('NOT_FOUND');
    expect(unverified.fields.youtube.status).toBe('NOT_FOUND');
    expect(supported.fields.linkedin.status).toBe('SUPPORTED');
    expect(supported.fields.linkedin.value).toBe('https://www.linkedin.com/in/ada-example');
  });

  it('counts the same source URL and copied excerpts once', () => {
    const copied = 'Ada Example is Founder of Fixture Northwind Buyers according to the public company profile page.';
    const result = evaluateContactQuality(input({
      evidence: [
        evidence({ id: 'evidence-a', excerpt: copied }),
        evidence({ id: 'evidence-b', sourceUrl: 'https://www.fixture-northwind.test/about/', excerpt: copied }),
        evidence({ id: 'evidence-c', sourceUrl: 'https://syndicated.example/copy', sourceType: 'NEWS', excerpt: copied }),
      ],
    }));
    expect(canonicalSourceUrl('https://www.fixture-northwind.test/about/')).toBe('https://fixture-northwind.test/about');
    expect(result.independentSources).toBe(1);
    expect(result.fields.name.status).toBe('SUPPORTED');
  });

  it('preserves disagreeing current and historical titles as a reviewable conflict', () => {
    const result = evaluateContactQuality(input({
      evidence: [
        evidence({ id: 'evidence-founder', value: 'Founder', excerpt: 'Ada Example is Founder of Fixture Northwind Buyers.' }),
        evidence({ id: 'evidence-former', field: 'title', value: 'Former CEO', sourceUrl: 'https://fixture-profile.test/interview', sourceType: 'INTERVIEW', excerpt: 'Ada Example, Former CEO of Fixture Northwind Buyers.' }),
      ],
    }));
    expect(result.role.storedTitle).toBe('Founder');
    expect(result.fields.title.status).toBe('CONFLICT');
    expect(result.conflicts[0]).toMatchObject({ fieldName: 'title', requiresReview: true, valueA: 'Founder', valueB: 'Former CEO' });
    expect(result.role.historical).toBe(true);
  });

  it('does not keep stale evidence marked verified', () => {
    const result = evaluateContactQuality(input({
      evidence: [
        evidence({ id: 'evidence-a', retrievedAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://fixture-northwind.test/about' }),
        evidence({ id: 'evidence-b', retrievedAt: '2026-01-02T00:00:00.000Z', sourceUrl: 'https://fixture-profile.test/ada', sourceType: 'PROFILE', excerpt: 'Ada Example is Founder of Fixture Northwind Buyers.' }),
      ],
    }));
    expect(result.fields.name.status).toBe('SUPPORTED');
    expect(result.retrievedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(result.discoveredAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps field statuses independent and explains every score component', () => {
    const result = evaluateContactQuality(input({
      contact: { id: 'contact-1', fullName: 'Ada Example', title: 'Founder', email: null, phone: null, linkedinUrl: 'https://instagram.example/not-a-profile', facebookUrl: null, instagramUrl: null, youtubeUrl: null, companyRelationship: null, createdAt: now },
    }));
    expect(result.fields.name.status).toBe('SUPPORTED');
    expect(result.fields.email.status).toBe('NOT_FOUND');
    expect(result.fields.linkedin.status).toBe('UNVERIFIED');
    expect(result.components.map((component) => component.name)).toEqual([
      'identity',
      'company_relationship',
      'role_evidence',
      'email_evidence',
      'social_evidence',
      'source_independence',
      'evidence_recency',
      'conflicts',
    ]);
    expect(result.components.every((component) => component.reason.length > 0)).toBe(true);
    expect(result.qualityScore).toBe(Math.max(0, Math.min(100, result.components.reduce((sum, component) => sum + component.points, 0))));
  });

  it('denies contact access across organizations', () => {
    expect(contactAccessAllowed('org-a', 'org-a')).toBe(true);
    expect(contactAccessAllowed('org-a', 'org-b')).toBe(false);
  });
});
