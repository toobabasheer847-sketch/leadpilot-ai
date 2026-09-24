import {
  acceptAiClaim,
  classifyPageFailure,
  dedupeUrls,
  evidenceIdentity,
  extractDecisionMakerCandidates,
  extractExplicitSocialLinks,
  extractLiteralEmails,
  extractLiteralPhones,
  extractVisibleText,
  normalizeResearchPhone,
  normalizeResearchUrl,
  planResearchPages,
  parseSupportedAddress,
  researchStopReason,
  scorePageRelevance,
  validatedResearchClaims,
} from './research.planner';

const html = `
  <html><head><style>.x{}</style><script>track()</script></head>
  <body>
    <nav>Home</nav>
    <h1>About</h1>
    <p>Ada Example is the Founder of Fixture Research Company.</p>
    <p>Email hello@fixture-research.test or call +1 415 555 0199.</p>
    <a href="https://www.linkedin.com/company/fixture-research">LinkedIn</a>
  </body></html>
`;

describe('deep research planning', () => {
  it('normalizes and deduplicates urls', () => {
    expect(normalizeResearchUrl('https://www.Example.com/about/?utm_source=ad#team')).toBe('https://example.com/about');
    expect(dedupeUrls(['https://example.com/about', 'https://www.example.com/about/', 'https://example.com/team'])).toEqual(['https://example.com/about', 'https://example.com/team']);
  });

  it('prioritizes relevant pages and enforces depth and page limits', () => {
    expect(scorePageRelevance('https://example.com/leadership', 'team')).toBeGreaterThan(scorePageRelevance('https://example.com/blog/post', 'news'));
    const planned = planResearchPages('https://example.com/', [
      { url: 'https://example.com/about', anchor: 'About', depth: 1 },
      { url: 'https://example.com/about', anchor: 'About duplicate', depth: 1 },
      { url: 'https://example.com/blog/one', anchor: 'News', depth: 1 },
      { url: 'https://example.com/team/person', anchor: 'Leadership', depth: 2 },
    ], 2, 1);
    expect(planned.selected.map((page) => page.url)).toEqual(['https://example.com/', 'https://example.com/about']);
    expect(planResearchPages('https://example.com/', [{ url: 'https://example.com/team', anchor: 'Team', depth: 2 }], 5, 1).stopReason).toBe('DEPTH_LIMIT');
  });

  it('treats robots and access denial as permanent and other fetch errors as transient', () => {
    expect(classifyPageFailure('Website disallowed by robots.txt.')).toBe('PERMANENT');
    expect(classifyPageFailure('Website fetch failed with HTTP 403.')).toBe('PERMANENT');
    expect(classifyPageFailure('Transient website fetch failure: timeout')).toBe('TRANSIENT');
  });

  it('extracts visible content, literal contacts, social links, and supported decision makers', () => {
    const text = extractVisibleText(html);
    expect(text).not.toContain('track()');
    expect(text).toContain('Ada Example is the Founder');
    expect(extractLiteralEmails(text)).toEqual(['hello@fixture-research.test']);
    expect(extractLiteralEmails('Ada Example works at fixture-research.test')).toEqual([]);
    expect(extractLiteralPhones(text)).toEqual(['+14155550199']);
    expect(normalizeResearchPhone('(415) 555-0100')).toBe('4155550100');
    expect(extractExplicitSocialLinks(html)).toEqual([{ platform: 'linkedin', url: 'https://linkedin.com/company/fixture-research' }]);
    expect(extractDecisionMakerCandidates(text, ['FOUNDER', 'MANAGER'])).toEqual([
      expect.objectContaining({ name: 'Ada Example', title: 'FOUNDER' }),
    ]);
  });

  it('creates stable evidence identities and drops claims that are not on the fetched page', () => {
    const first = evidenceIdentity('company', 'email', 'https://www.example.com/contact/', 'Hello@Example.com');
    const second = evidenceIdentity('company', 'email', 'https://example.com/contact', 'hello@example.com');
    expect(first).toBe(second);
    const pages = [{ url: 'https://example.com/about', text: 'Ada Example is the Founder of Fixture Research Company.' }];
    expect(acceptAiClaim({ sourceUrl: 'https://example.com/about', evidenceExcerpt: 'Ada Example is the Founder', value: 'Ada Example' }, pages)).toBe(true);
    expect(acceptAiClaim({ sourceUrl: 'https://example.com/about', evidenceExcerpt: 'Invented person is CEO', value: 'Invented' }, pages)).toBe(false);
    expect(acceptAiClaim({ sourceUrl: 'https://other.example/page', evidenceExcerpt: 'Ada Example is the Founder', value: 'Ada Example' }, pages)).toBe(false);
    expect(validatedResearchClaims({ claims: [{ field: 'title', value: 'Founder', sourceUrl: 'https://example.com/about', evidenceExcerpt: 'Founder' }, { field: 'email' }] })).toEqual([
      { field: 'title', value: 'Founder', sourceUrl: 'https://example.com/about', evidenceExcerpt: 'Founder' },
    ]);
  });

  it('stops for budget, timeout, quota, sufficient evidence, and exhausted pages', () => {
    expect(researchStopReason({ timedOut: true, quotaReached: false, pagesProcessed: 1, maxPages: 8, pendingRelevant: 2, hasDescription: false, hasContact: false, pendingLeadership: 1 })).toBe('TIMEOUT');
    expect(researchStopReason({ timedOut: false, quotaReached: true, pagesProcessed: 1, maxPages: 8, pendingRelevant: 2, hasDescription: false, hasContact: false, pendingLeadership: 1 })).toBe('QUOTA');
    expect(researchStopReason({ timedOut: false, quotaReached: false, pagesProcessed: 8, maxPages: 8, pendingRelevant: 2, hasDescription: false, hasContact: false, pendingLeadership: 1 })).toBe('PAGE_BUDGET');
    expect(researchStopReason({ timedOut: false, quotaReached: false, pagesProcessed: 2, maxPages: 8, pendingRelevant: 1, hasDescription: true, hasContact: true, pendingLeadership: 0 })).toBe('SUFFICIENT_EVIDENCE');
    expect(researchStopReason({ timedOut: false, quotaReached: false, pagesProcessed: 1, maxPages: 8, pendingRelevant: 0, hasDescription: false, hasContact: false, pendingLeadership: 0 })).toBe('RELEVANT_PAGES_EXHAUSTED');
    expect(parseSupportedAddress('100 Public Street, Austin, TX 78701')).toEqual({ address: '100 Public Street', city: 'Austin', state: 'TX', postalCode: '78701' });
    expect(parseSupportedAddress('call the office')).toBeNull();
  });
});
