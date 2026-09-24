import { WebsiteContactProvider } from './providers/website-contact.provider';
import { PersonIdentityMatcherService } from './matching/person-identity-matcher.service';
import { ContactCandidate } from './types/contact.types';
import { ContactExtractorService } from './extraction/contact-extractor.service';
import { WebsiteDiscoveryService } from '../enrichment/website/website-discovery.service';
import { WebsiteNormalizerService } from '../enrichment/website/website-normalizer.service';
import { ConfigService } from '@nestjs/config';

describe('Contact discovery primitives', () => {
  it('detects founder and CEO titles from website text', () => {
    const extractor = new ContactExtractorService({ get: () => ['CEO', 'FOUNDER', 'PRESIDENT'] } as ConfigService);
    const provider = new WebsiteContactProvider(extractor, {} as WebsiteDiscoveryService, new WebsiteNormalizerService());
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

  it('does not merge people because their names are similar', () => {
    const matcher = new PersonIdentityMatcherService();
    const result = matcher.match(
      { fullName: 'Ada Example', title: 'Founder', companyName: 'Fixture Northwind Buyers', sourceUrl: 'https://fixture-northwind.test/about', evidence: [], normalizedName: 'ada example', status: 'DISCOVERED', verificationStatus: 'NOT_VERIFIED' },
      { fullName: 'Ada Examples', title: 'Founder', companyName: 'Fixture Northwind Buyers', sourceUrl: 'https://fixture-northwind.test/about', evidence: [], normalizedName: 'ada examples', status: 'DISCOVERED', verificationStatus: 'NOT_VERIFIED' },
    );
    expect(result.samePerson).toBe(false);
  });

  it('does not invent people, titles, or emails when a page has no explicit person evidence', () => {
    const extractor = new ContactExtractorService({ get: () => ['CEO', 'FOUNDER'] } as ConfigService);
    const provider = new WebsiteContactProvider(extractor, {} as WebsiteDiscoveryService, new WebsiteNormalizerService());
    const candidates = provider.extractCandidatesFromHtml('https://company.example/about', '<html><body><h1>About our company</h1><p>We serve local businesses.</p></body></html>', 'Actual Company');
    expect(candidates).toEqual([]);
  });
});
