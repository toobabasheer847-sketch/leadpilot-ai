const UI_STOPWORDS = new Set([
  'share', 'article', 'articles', 'related', 'posts', 'post', 'search', 'menu', 'home', 'blog', 'blogs',
  'guide', 'guides', 'click', 'subscribe', 'newsletter', 'cookie', 'privacy', 'terms', 'login', 'signup',
  'sign', 'register', 'follow', 'about', 'contact', 'welcome', 'services', 'industries', 'company', 'page',
  'team', 'leadership', 'our', 'the', 'read', 'more', 'next', 'previous', 'back', 'skip', 'content',
  'navigation', 'footer', 'header', 'sidebar', 'comment', 'comments', 'reply', 'replies', 'tag', 'tags',
  'category', 'categories', 'archive', 'archives', 'featured', 'trending', 'popular', 'recent',
]);

const BUSINESS_ROLE_TOKENS = new Set([
  'flipper', 'flippers', 'investor', 'investors', 'investment', 'investments', 'wholesaler', 'wholesalers',
  'realty', 'realtor', 'realtors', 'broker', 'brokers', 'brokerage', 'capital', 'holdings', 'properties',
  'property', 'house', 'homes', 'houses', 'real', 'estate', 'llc', 'inc', 'corp', 'ltd', 'group', 'partners', 'ventures',
  'fund', 'funds', 'management', 'managers', 'agency', 'agencies', 'solutions', 'consulting',
]);

/**
 * Reject page UI chrome and company-like phrases that the Capitalized Word regex misreads as people.
 */
export function isPlausiblePersonName(name: string, companyName?: string | null): boolean {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  if (!cleaned) return false;
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;
  if (parts.some((part) => !/^[A-Z][a-z'’-]+$/.test(part) && !/^[A-Z][a-z]+-[A-Z][a-z]+$/.test(part))) return false;
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => UI_STOPWORDS.has(part) || BUSINESS_ROLE_TOKENS.has(part))) return false;
  if (companyName?.trim()) {
    const companyTokens = distinctiveCompanyTokens(companyName);
    if (companyTokens.length && lowerParts.every((part) => companyTokens.includes(part))) return false;
    if (lowerParts.some((part) => companyTokens.includes(part) && part.length >= 5)) {
      // Allow shared first/last names; reject when a distinctive company token is used as a "name" word.
      const companyLower = companyName.toLowerCase();
      if (companyLower.includes(cleaned.toLowerCase())) return false;
    }
  }
  return true;
}

function distinctiveCompanyTokens(companyName: string): string[] {
  return companyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !UI_STOPWORDS.has(token) && !['investments', 'investment', 'capital', 'group', 'partners', 'properties', 'company', 'holdings', 'inc', 'llc'].includes(token));
}
