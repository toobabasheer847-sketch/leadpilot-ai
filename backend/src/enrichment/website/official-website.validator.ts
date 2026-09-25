export type OfficialWebsiteRejection =
  | 'DIFFERENT_COMPANY'
  | 'DIRECTORY'
  | 'SOCIAL_PROFILE'
  | 'PROXY_OR_FILING'
  | 'REVIEW_SITE'
  | 'NEWS_ARTICLE'
  | 'MARKETPLACE'
  | 'GENERIC_THIRD_PARTY_PAGE'
  | 'INSUFFICIENT_COMPANY_MATCH'
  | 'FETCH_FAILED'
  | 'FETCH_TIMEOUT'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'CONNECTION_ERROR'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'REDIRECT_ERROR'
  | 'INVALID_CONTENT'
  | 'BLOCKED'
  | 'UNKNOWN_FETCH_ERROR';

export type OfficialWebsiteDecision =
  | { accepted: true; reason: 'OFFICIAL_WEBSITE'; score: number }
  | { accepted: false; reason: OfficialWebsiteRejection; score: 0 };

const LEGAL_TOKENS = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd', 'limited', 'company', 'lp', 'llp', 'pllc', 'plc']);
const QUALIFIERS = ['investments', 'investors', 'investment', 'capital', 'holdings', 'partners', 'partner', 'properties', 'property', 'realty', 'ventures', 'equity', 'advisors', 'advisor', 'management', 'fund', 'funds', 'trust', 'group'];
const QUALIFIER_SET = new Set(QUALIFIERS);
const GENERIC_BRANDS = new Set(['home', 'homepage', 'welcome', 'official', 'official site', 'official website', 'about', 'about us', 'contact', 'contact us']);
const DIRECTORY_TEMPLATE = /company profile|business profile|business directory|funding,?\s+team|team\s*&\s*investors|investor profile|startup profile|companies like|view all companies|listed companies/i;
const FILING_TEMPLATE = /definitive proxy|proxy statement|schedule 14a|form 10-k|form 10-q|proxy voting|securities and exchange commission/i;
const NEWS_PATH = /\/(news|article|articles|press|stories)\b|\/20\d{2}\/\d{2}\//i;

const HOST_REASONS: Array<{ reason: OfficialWebsiteRejection; hosts: string[] }> = [
  { reason: 'SOCIAL_PROFILE', hosts: ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'threads.net'] },
  { reason: 'REVIEW_SITE', hosts: ['yelp.com', 'yellowpages.com', 'tripadvisor.com', 'glassdoor.com', 'trustpilot.com', 'angi.com', 'thumbtack.com', 'bbb.org', 'g2.com', 'capterra.com', 'sitejabber.com'] },
  { reason: 'DIRECTORY', hosts: ['crunchbase.com', 'zoominfo.com', 'opencorporates.com', 'manta.com', 'dnb.com', 'pitchbook.com', 'owler.com', 'rocketreach.co', 'apollo.io', 'signalhire.com', 'datanyze.com', 'cbinsights.com', 'craft.co', 'buzzfile.com', 'corporationwiki.com', 'bizapedia.com', 'kompass.com', 'hoovers.com'] },
  { reason: 'PROXY_OR_FILING', hosts: ['proxyvote.com', 'sec.gov', 'sedar.com', 'sedarplus.ca', 'bamsec.com', 'last10k.com', 'annualreports.com', 'edgar-online.com', 'secfilings.com', 'companieshouse.gov.uk'] },
  { reason: 'NEWS_ARTICLE', hosts: ['reuters.com', 'apnews.com', 'nytimes.com', 'wsj.com', 'forbes.com', 'cnbc.com', 'marketwatch.com', 'yahoo.com', 'seekingalpha.com', 'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'techcrunch.com', 'ft.com', 'bizjournals.com', 'axios.com'] },
  { reason: 'MARKETPLACE', hosts: ['amazon.com', 'ebay.com', 'etsy.com', 'apps.apple.com', 'play.google.com'] },
  { reason: 'GENERIC_THIRD_PARTY_PAGE', hosts: ['wikipedia.org', 'wikidata.org', 'bloomberg.com'] },
];

export function classifyOfficialWebsiteHost(hostname: string): OfficialWebsiteRejection | null {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  for (const group of HOST_REASONS) {
    if (group.hosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return group.reason;
  }
  return null;
}

export function evaluateOfficialWebsite(input: {
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  url?: string | null;
  title?: string | null;
  text?: string | null;
  html?: string | null;
}): OfficialWebsiteDecision {
  const companyName = input.companyName?.trim() ?? '';
  const title = input.title?.trim() ?? '';
  const text = `${title} ${input.text ?? ''}`.replace(/\s+/g, ' ').trim();
  const url = input.url?.trim() || '';
  let hostname = '';
  let pathname = '';
  if (url) {
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      hostname = '';
    }
  }
  const hostReason = hostname ? classifyOfficialWebsiteHost(hostname) : null;
  if (hostReason) return reject(hostReason);

  const target = nameParts(companyName);
  if (target.distinctive.length === 0) return reject('INSUFFICIENT_COMPANY_MATCH');
  const normalizedName = normalize(companyName);
  const firstParty = hostname ? domainSupportsCompany(hostname, companyName) : false;
  const lead = leadSubject(input.text ?? '', companyName);
  const titleSubject = titleSubjectName(title);
  if (lead && isDifferentEntity(companyName, lead) && !firstParty) return reject('DIFFERENT_COMPANY');
  if (titleSubject && isDifferentEntity(companyName, titleSubject) && !normalize(title).includes(normalizedName)) return reject('DIFFERENT_COMPANY');
  if (hostname && domainHasForeignQualifier(hostname, companyName) && !normalize(title).includes(normalizedName)) return reject('DIFFERENT_COMPANY');

  const thirdParty = Boolean(hostname) && !firstParty;
  if (thirdParty && FILING_TEMPLATE.test(text)) return reject('PROXY_OR_FILING');
  if (thirdParty && (DIRECTORY_TEMPLATE.test(`${title} ${input.text ?? ''}`) || DIRECTORY_TEMPLATE.test(title))) return reject('DIRECTORY');
  if (thirdParty && NEWS_PATH.test(pathname)) return reject('NEWS_ARTICLE');
  const brand = siteBrand(title);
  if (thirdParty && brand && !brandMatchesCompany(brand, companyName, input.city, input.state)) return reject('GENERIC_THIRD_PARTY_PAGE');

  const heading = input.html ? firstHeading(input.html) : '';
  const schemaName = input.html ? schemaOrganizationName(input.html) : '';
  const identity = [title, heading, schemaName].map((value) => normalize(value));
  const fullName = identity.some((value) => value.includes(normalizedName)) || normalize(leadSubject(input.text ?? '', companyName) ?? '').includes(normalizedName);
  const phrase = target.distinctive.join(' ');
  const phraseInIdentity = identity.some((value) => value.includes(phrase)) || normalize(input.text ?? '').includes(`${phrase} is `);
  const location = [input.city, input.state].map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value));
  const locationMatches = location.some((term) => text.toLowerCase().includes(term));
  const contact = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(text) || /@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  const brandingSupported = phraseInIdentity && !identity.some((value) => value && isDifferentEntity(companyName, value)) && (firstParty || locationMatches || contact || normalize(input.text ?? '').includes(normalizedName));

  const shortNameOnOwnedDomain = target.distinctive.length < 2
    && !fullName
    && firstParty
    && target.qualifiers.some((qualifier) => registrableLabel(hostname).includes(qualifier))
    && target.distinctive.every((token) => normalize(title).includes(token))
    && !lead;
  if (target.distinctive.length < 2 && !fullName && !shortNameOnOwnedDomain) return reject('INSUFFICIENT_COMPANY_MATCH');
  if (!fullName && !brandingSupported && !shortNameOnOwnedDomain) return reject('INSUFFICIENT_COMPANY_MATCH');

  let score = fullName ? 20 : 12;
  if (identity.some((value) => value.includes(normalizedName) && value.startsWith(normalizedName.slice(0, Math.min(12, normalizedName.length))))) score += 4;
  if (firstParty) score += 8;
  if (locationMatches) score += 4;
  if (contact) score += 2;
  return { accepted: true, reason: 'OFFICIAL_WEBSITE', score };
}

function reject(reason: OfficialWebsiteRejection): OfficialWebsiteDecision {
  return { accepted: false, reason, score: 0 };
}

function nameParts(name: string): { distinctive: string[]; qualifiers: string[] } {
  const tokens = normalize(name).split(' ').filter((token) => token.length >= 3 && !LEGAL_TOKENS.has(token) && !['and', 'the', 'for'].includes(token));
  return {
    distinctive: tokens.filter((token) => !QUALIFIER_SET.has(token)),
    qualifiers: tokens.filter((token) => QUALIFIER_SET.has(token)),
  };
}

function isDifferentEntity(targetName: string, candidateName: string): boolean {
  const target = nameParts(targetName);
  const candidate = nameParts(candidateName);
  if (candidate.distinctive.length === 0) return false;
  const shared = target.distinctive.filter((token) => candidate.distinctive.includes(token));
  if (shared.length === 0) return false;
  if (candidate.distinctive.some((token) => !target.distinctive.includes(token))) return true;
  if (target.qualifiers.length > 0 && candidate.qualifiers.length > 0 && !target.qualifiers.some((token) => candidate.qualifiers.includes(token))) return true;
  return false;
}

function domainSupportsCompany(hostname: string, companyName: string): boolean {
  const label = registrableLabel(hostname);
  const parts = nameParts(companyName);
  if (!parts.distinctive.every((token) => label.includes(token))) return false;
  if (domainHasForeignQualifier(hostname, companyName)) return false;
  return true;
}

function domainHasForeignQualifier(hostname: string, companyName: string): boolean {
  const label = registrableLabel(hostname);
  const parts = nameParts(companyName);
  return QUALIFIERS.some((qualifier) => !parts.qualifiers.includes(qualifier) && label.includes(qualifier));
}

function registrableLabel(hostname: string): string {
  const parts = hostname.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  const label = parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0] ?? '';
  return label.replace(/[^a-z0-9]/g, '');
}

function siteBrand(title: string): string | null {
  const parts = title.split(/\s+[|–—]\s+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

function brandMatchesCompany(brand: string, companyName: string, city?: string | null, state?: string | null): boolean {
  const normalized = normalize(brand);
  if (!normalized || GENERIC_BRANDS.has(normalized)) return true;
  const place = [city, state].map((value) => value?.trim().toLowerCase()).filter(Boolean);
  if (place.some((value) => value && normalized.includes(value))) return true;
  if (normalize(companyName).includes(normalized) || normalized.includes(normalize(companyName))) return true;
  const parts = nameParts(companyName);
  return parts.distinctive.some((token) => normalized.includes(token)) || parts.qualifiers.some((token) => normalized === token);
}

function titleSubjectName(title: string): string {
  const head = title.split(/\s+[|–—]\s+|\s+-\s+/)[0] ?? '';
  const subject = head.split(':')[0]?.trim() ?? '';
  if (!subject || DIRECTORY_TEMPLATE.test(subject) || GENERIC_BRANDS.has(normalize(subject))) return '';
  return subject;
}

function leadSubject(text: string, companyName: string): string | null {
  const sample = text.replace(/\s+/g, ' ').slice(0, 800);
  const match = sample.match(/([A-Z][A-Za-z0-9&.'’ -]{2,80}?)\s+is\s+(?:an?\b|the\b)/);
  if (!match) return null;
  const candidate = match[1].trim();
  const parts = nameParts(candidate);
  const target = nameParts(companyName);
  if (!parts.distinctive.some((token) => target.distinctive.includes(token))) return null;
  return candidate;
}

function firstHeading(html: string): string {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function schemaOrganizationName(html: string): string {
  const match = html.match(/"@type"\s*:\s*"(?:Organization|LocalBusiness|Corporation)"[\s\S]{0,500}?"name"\s*:\s*"([^"]+)"/i);
  return match?.[1]?.trim() ?? '';
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
