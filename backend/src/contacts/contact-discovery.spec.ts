import { WebsiteContactProvider } from './providers/website-contact.provider';
import { PersonIdentityMatcherService } from './matching/person-identity-matcher.service';
import { ContactCandidate } from './types/contact.types';

describe('Contact discovery primitives', () => {
  it('detects founder and CEO titles from website text', () => {
    const provider = new WebsiteContactProvider();
    const html = `
      <html><body>
        <a href="/about">About</a>
        <p>John Smith is the Founder and CEO of Example Cash Home Buyers.</p>
      </body></html>
    `;

    const candidates = provider.extractCandidatesFromHtml('https://example.test/about', html, 'Example Cash Home Buyers');
    expect(candidates.some((candidate) => candidate.title === 'FOUNDER')).toBe(true);
    expect(candidates.some((candidate) => candidate.title === 'CEO')).toBe(true);
    expect(candidates[0].fullName).toBe('John Smith');
  });

  it('does not merge different companies by name alone', () => {
    const matcher = new PersonIdentityMatcherService();
    const first: ContactCandidate = {
      fullName: 'John Smith',
      title: 'Founder',
      companyName: 'Example Cash Home Buyers',
      sourceUrl: 'https://example.test/about',
      evidence: [],
      normalizedName: 'john smith',
      status: 'DISCOVERED',
      verificationStatus: 'NOT_VERIFIED',
    };
    const second: ContactCandidate = {
      fullName: 'John Smith',
      title: 'Founder',
      companyName: 'Other Holdings',
      sourceUrl: 'https://other.example/about',
      evidence: [],
      normalizedName: 'john smith',
      status: 'DISCOVERED',
      verificationStatus: 'NOT_VERIFIED',
    };

    const result = matcher.match(first, second);
    expect(result.samePerson).toBe(false);
  });
});
