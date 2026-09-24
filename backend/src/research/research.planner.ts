export interface ResearchLink {
  url: string;
  anchor: string;
  depth: number;
}

export interface PlannedPage {
  url: string;
  depth: number;
  score: number;
}

export type ResearchStopReason = 'PAGE_BUDGET' | 'DEPTH_LIMIT' | 'RELEVANT_PAGES_EXHAUSTED' | 'SUFFICIENT_EVIDENCE' | 'QUOTA' | 'TIMEOUT';

const PRIORITY_PATHS = ['/', '/about', '/about-us', '/team', '/leadership', '/management', '/company', '/contact', '/our-team', '/who-we-are', '/services', '/properties', '/portfolio', '/investments'];
const RELEVANCE_TERMS = ['leadership', 'founder', 'ceo', 'president', 'owner', 'management', 'team', 'company', 'acquisition', 'investment', 'properties', 'portfolio', 'contact', 'email', 'phone', 'linkedin', 'facebook', 'instagram', 'youtube'];

export function normalizeResearchUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const tracking = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']);
    const parameters = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!tracking.has(key.toLowerCase())) parameters.append(key, value);
    }
    parsed.search = parameters.toString();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractPageLinks(html: string, baseUrl: string, depth: number): ResearchLink[] {
  const links: ResearchLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let resolved: string;
    try { resolved = new URL(match[1], baseUrl).toString(); } catch { continue; }
    const url = normalizeResearchUrl(resolved);
    if (!url || seen.has(url)) continue;
    let baseHost = '';
    let linkHost = '';
    try {
      baseHost = new URL(baseUrl).hostname.replace(/^www\./, '');
      linkHost = new URL(url).hostname;
    } catch { continue; }
    if (baseHost !== linkHost) continue;
    seen.add(url);
    const anchor = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    links.push({ url, anchor, depth });
  }
  return links;
}

export function dedupeUrls(urls: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const normalized = normalizeResearchUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

export function scorePageRelevance(url: string, anchor = '') {
  let score = 0;
  let path = '/';
  try { path = new URL(url).pathname.toLowerCase() || '/'; } catch { return 0; }
  if (path === '/' || path === '') score += 5;
  if (PRIORITY_PATHS.some((item) => item !== '/' && (path === item || path.endsWith(item)))) score += 8;
  const text = `${path} ${anchor}`.toLowerCase();
  for (const term of RELEVANCE_TERMS) {
    if (text.includes(term)) score += 2;
  }
  return score;
}

export function planResearchPages(homepage: string, links: ResearchLink[], maxPages: number, maxDepth: number) {
  const selected: PlannedPage[] = [];
  const seen = new Set<string>();
  const home = normalizeResearchUrl(homepage);
  if (home) {
    selected.push({ url: home, depth: 0, score: scorePageRelevance(home, 'home') });
    seen.add(home);
  }
  const normalizedLinks = links.map((link) => ({ ...link, url: normalizeResearchUrl(link.url) ?? '', score: scorePageRelevance(link.url, link.anchor) })).filter((link) => link.url && link.score > 0);
  const depthLimited = normalizedLinks.some((link) => link.depth > maxDepth);
  const ranked = normalizedLinks.filter((link) => link.depth <= maxDepth && !seen.has(link.url)).sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  for (const link of ranked) {
    if (selected.length >= maxPages) break;
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    selected.push({ url: link.url, depth: link.depth, score: link.score });
  }
  const stopReason: ResearchStopReason = selected.length >= maxPages ? 'PAGE_BUDGET' : depthLimited && selected.length <= 1 ? 'DEPTH_LIMIT' : 'RELEVANT_PAGES_EXHAUSTED';
  return { selected, stopReason };
}

export function extractVisibleText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLiteralEmails(text: string) {
  return [...new Set([...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((match) => match[0].toLowerCase()))];
}

export function normalizeResearchPhone(value: string) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export function extractLiteralPhones(text: string) {
  const matches = text.match(/(?:\+\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g) ?? [];
  return [...new Set(matches.map((item) => normalizeResearchPhone(item)).filter((item): item is string => Boolean(item)))];
}

export function extractExplicitSocialLinks(html: string) {
  const profiles: Array<{ platform: 'linkedin' | 'facebook' | 'instagram' | 'youtube'; url: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let parsed: URL;
    try { parsed = new URL(match[1]); } catch { continue; }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const platform = host === 'linkedin.com' ? 'linkedin' : host === 'facebook.com' ? 'facebook' : host === 'instagram.com' ? 'instagram' : host === 'youtube.com' || host === 'youtu.be' ? 'youtube' : null;
    if (!platform) continue;
    const url = normalizeResearchUrl(parsed.toString());
    if (!url || seen.has(url)) continue;
    seen.add(url);
    profiles.push({ platform, url });
  }
  return profiles;
}

export function extractDecisionMakerCandidates(text: string, roles: string[]) {
  const ordered = [...roles].sort((left, right) => right.length - left.length);
  const candidates: Array<{ name: string; title: string; excerpt: string }> = [];
  const seen = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const role = ordered.find((item) => sentence.toLowerCase().includes(item.toLowerCase().replace(/_/g, ' ')) || sentence.toLowerCase().includes(item.toLowerCase().replace(/_/g, '-')));
    const nameMatch = sentence.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
    if (!role || !nameMatch) continue;
    const tokens = nameMatch[1].split(' ');
    while (tokens.length && ['About', 'The', 'Our', 'Home', 'Contact', 'Email'].includes(tokens[0])) tokens.shift();
    if (tokens.length < 2) continue;
    const name = tokens.slice(0, 3).join(' ');
    const key = `${name.toLowerCase()}|${role.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ name, title: role.replace(/_/g, ' '), excerpt: sentence.trim() });
  }
  return candidates;
}

export function evidenceIdentity(companyId: string, field: string, sourceUrl: string, value: string) {
  return `${companyId}|${field}|${normalizeResearchUrl(sourceUrl) ?? sourceUrl}|${value.trim().toLowerCase()}`;
}

export function classifyPageFailure(message: string): 'PERMANENT' | 'TRANSIENT' {
  const normalized = message.toLowerCase();
  if (normalized.includes('robots') || normalized.includes('401') || normalized.includes('403') || normalized.includes('404') || normalized.includes('unsupported content') || normalized.includes('blocked')) return 'PERMANENT';
  return 'TRANSIENT';
}

export function researchStopReason(input: { timedOut: boolean; quotaReached: boolean; pagesProcessed: number; maxPages: number; pendingRelevant: number; hasDescription: boolean; hasContact: boolean; pendingLeadership: number }): ResearchStopReason {
  if (input.timedOut) return 'TIMEOUT';
  if (input.quotaReached) return 'QUOTA';
  if (input.pagesProcessed >= input.maxPages) return 'PAGE_BUDGET';
  if (input.hasDescription && input.hasContact && input.pendingLeadership === 0) return 'SUFFICIENT_EVIDENCE';
  if (input.pendingRelevant === 0) return 'RELEVANT_PAGES_EXHAUSTED';
  return 'DEPTH_LIMIT';
}

export function validatedResearchClaims(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const claims = (value as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return [];
  return claims.flatMap((claim) => {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return [];
    const item = claim as Record<string, unknown>;
    if (typeof item.field !== 'string' || typeof item.value !== 'string' || typeof item.sourceUrl !== 'string' || typeof item.evidenceExcerpt !== 'string') return [];
    if (!item.field.trim() || !item.value.trim() || !item.sourceUrl.trim() || !item.evidenceExcerpt.trim()) return [];
    return [{ field: item.field.trim(), value: item.value.trim(), sourceUrl: item.sourceUrl.trim(), evidenceExcerpt: item.evidenceExcerpt.trim() }];
  });
}

export function acceptAiClaim(claim: { sourceUrl?: string; evidenceExcerpt?: string; value?: string | null }, pages: Array<{ url: string; text: string }>) {
  if (!claim.sourceUrl || !claim.evidenceExcerpt || !claim.value) return false;
  const source = normalizeResearchUrl(claim.sourceUrl);
  const page = pages.find((item) => normalizeResearchUrl(item.url) === source);
  if (!page) return false;
  return page.text.toLowerCase().includes(claim.evidenceExcerpt.toLowerCase().replace(/\s+/g, ' ').trim());
}
