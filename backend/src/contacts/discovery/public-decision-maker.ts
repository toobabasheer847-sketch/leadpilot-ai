import { publicPersonEmail } from '../extraction/contact-extractor.service';
import type { ContactCandidate } from '../types/contact.types';

const TITLES: Array<[RegExp, string]> = [
  [/\bco-founder\b/i, 'Co-Founder'],
  [/\bcofounder\b/i, 'Co-Founder'],
  [/\bfounder\b/i, 'Founder'],
  [/\bmanaging partner\b/i, 'Managing Partner'],
  [/\bmanaging director\b/i, 'Managing Director'],
  [/\binvestment manager\b/i, 'Investment Manager'],
  [/\bgeneral manager\b/i, 'General Manager'],
  [/\bchief executive officer\b/i, 'CEO'],
  [/\bceo\b/i, 'CEO'],
  [/\bpresident\b/i, 'President'],
  [/\bowner\b/i, 'Owner'],
  [/\bprincipal\b/i, 'Principal'],
  [/\bpartner\b/i, 'Partner'],
  [/\bdirector\b/i, 'Director'],
  [/\bmanager\b/i, 'Manager'],
];

const NAME = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
const BLOCKED_NAMES = /^(real estate|texas|linkedin|facebook|instagram|youtube|twitter|managing partner|managing director|general manager|investment manager|chief executive|private equity)$/i;

export function decisionMakerQueries(companyName: string, roles?: string[]): string[] {
  const name = companyName.trim();
  if (!name) return [];
  const roleTerms = (roles?.length ? roles : ['Founder', 'CEO', 'President', 'Owner', 'Managing Director'])
    .map((role) => role.trim())
    .filter(Boolean)
    .slice(0, 8);
  return roleTerms.map((role) => {
    const term = /\s/.test(role) ? `"${role}"` : role;
    return `"${name}" ${term}`;
  });
}

export function assessPublicDecisionMaker(
  companyName: string,
  hit: { title: string; url: string; snippet: string; source?: string; retrievedAt?: string },
  options?: { allowedRoles?: string[] },
): ContactCandidate | null {
  const text = `${hit.title}. ${hit.snippet}`.replace(/\s+/g, ' ').trim();
  const title = TITLES.find(([pattern]) => pattern.test(text));
  if (!title) return null;
  if (options?.allowedRoles?.length && !roleMatches(title[1], options.allowedRoles)) return null;
  const fullName = personName(text, title[1], companyName);
  if (!fullName) return null;
  const clause = personWindows(text, fullName);
  if (!companyAssociated(companyName, clause)) return null;
  if (otherCompanyAffiliation(clause, companyName)) return null;
  const email = publicPersonEmail(clause);
  const profiles = personProfiles(hit.url);
  const retrievedAt = hit.retrievedAt ?? new Date().toISOString();
  const evidence = [
    evidenceEntry('fullName', fullName, hit.url, text, retrievedAt),
    evidenceEntry('title', title[1], hit.url, text, retrievedAt),
    evidenceEntry('companyRelationship', companyName, hit.url, text, retrievedAt),
  ];
  if (email) evidence.push(evidenceEntry('email', email, hit.url, text, retrievedAt));
  for (const url of Object.values(profiles)) {
    if (url) evidence.push(evidenceEntry('profileUrl', url, hit.url, text, retrievedAt));
  }
  const parts = fullName.split(/\s+/);
  return {
    fullName,
    firstName: parts[0],
    lastName: parts.slice(1).join(' ') || null,
    title: title[1],
    originalTitle: title[1],
    companyRelationship: companyName,
    email,
    emailStatus: email ? 'UNVERIFIED' : 'NOT_FOUND',
    phone: null,
    phoneStatus: 'NOT_FOUND',
    ...profiles,
    companyName,
    sourceUrl: hit.url,
    evidence,
    normalizedName: fullName.toLowerCase(),
    status: 'DISCOVERED',
    verificationStatus: 'NOT_VERIFIED',
  };
}

export function roleMatches(title: string, allowedRoles: string[]): boolean {
  const normalizedTitle = title.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return allowedRoles.some((role) => {
    const normalizedRole = role.trim().toLowerCase().replace(/[_-]+/g, ' ');
    if (!normalizedRole) return false;
    if (normalizedTitle === normalizedRole) return true;
    if (normalizedTitle.includes(normalizedRole) || normalizedRole.includes(normalizedTitle)) return true;
    const compactTitle = normalizedTitle.replace(/\s+/g, '');
    const compactRole = normalizedRole.replace(/\s+/g, '');
    return compactTitle === compactRole || compactTitle.includes(compactRole) || compactRole.includes(compactTitle);
  });
}

function companyAssociated(companyName: string, text: string): boolean {
  const normalized = companyName.trim().toLowerCase();
  if (normalized.length >= 3 && text.toLowerCase().includes(normalized)) return true;
  const tokens = distinctiveTokens(companyName);
  return tokens.length > 0 && tokens.every((token) => text.toLowerCase().includes(token));
}

function otherCompanyAffiliation(clause: string, companyName: string): boolean {
  const match = clause.match(/\b(?:of|at|for)\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,5})/u);
  if (!match) return false;
  const named = match[1].replace(/\b(Inc|LLC|Ltd|GmbH|Co)\b\.?/gi, '').trim();
  if (named.length < 3) return false;
  return !companyAssociated(companyName, named) && !companyAssociated(named, companyName);
}

function personWindows(text: string, personName: string): string {
  const lower = text.toLowerCase();
  const name = personName.toLowerCase();
  const windows: string[] = [];
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf(name, from);
    if (at < 0) break;
    windows.push(text.slice(Math.max(0, at - 80), Math.min(text.length, at + name.length + 180)));
    from = at + name.length;
  }
  return windows.join(' ') || text;
}

function distinctiveTokens(companyName: string): string[] {
  return companyName.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['investments', 'investment', 'capital', 'group', 'partners', 'properties', 'company', 'holdings'].includes(token));
}

function personName(text: string, title: string, companyName: string): string | null {
  const titleAt = text.toLowerCase().search(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const window = titleAt >= 0 ? text.slice(Math.max(0, titleAt - 80), Math.min(text.length, titleAt + title.length + 80)) : text;
  const company = companyName.toLowerCase();
  for (const match of window.matchAll(NAME)) {
    const candidate = match[1].trim();
    if (BLOCKED_NAMES.test(candidate)) continue;
    if (candidate.toLowerCase() === title.toLowerCase()) continue;
    if (TITLES.some(([, label]) => label.toLowerCase() === candidate.toLowerCase())) continue;
    if (company.includes(candidate.toLowerCase())) continue;
    return candidate;
  }
  return null;
}

function personProfiles(url: string): Pick<ContactCandidate, 'linkedinUrl' | 'facebookUrl' | 'instagramUrl' | 'youtubeUrl' | 'twitterUrl'> {
  const profiles: Pick<ContactCandidate, 'linkedinUrl' | 'facebookUrl' | 'instagramUrl' | 'youtubeUrl' | 'twitterUrl'> = {};
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (!isPersonProfileUrl(parsed.toString())) return profiles;
    if ((host === 'linkedin.com' || host.endsWith('.linkedin.com')) && path.startsWith('/in/')) profiles.linkedinUrl = parsed.toString();
    else if ((host === 'facebook.com' || host.endsWith('.facebook.com')) && path.length > 1 && !path.startsWith('/pages')) profiles.facebookUrl = parsed.toString();
    else if ((host === 'instagram.com' || host.endsWith('.instagram.com')) && !path.startsWith('/p/') && !path.startsWith('/reel')) profiles.instagramUrl = parsed.toString();
    else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (path.startsWith('/@') || path.startsWith('/user/')) profiles.youtubeUrl = parsed.toString();
    }
    else if (host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com') || host.endsWith('.x.com')) {
      if (!path.startsWith('/status') && path.split('/').filter(Boolean).length === 1) profiles.twitterUrl = parsed.toString();
    }
  } catch {
    return profiles;
  }
  return profiles;
}

export function isPersonProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (host.endsWith('linkedin.com')) return path.startsWith('/in/');
    if (host.endsWith('facebook.com')) return path.length > 1 && !path.startsWith('/pages') && !path.startsWith('/groups');
    if (host.endsWith('instagram.com')) return path.length > 1 && !path.startsWith('/p/') && !path.startsWith('/reel');
    if (host.endsWith('youtube.com')) return path.startsWith('/@') || path.startsWith('/user/');
    if (host.endsWith('twitter.com') || host.endsWith('x.com')) return !path.includes('/status/') && path.split('/').filter(Boolean).length === 1;
    return false;
  } catch {
    return false;
  }
}

export function isCompanyProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (host.endsWith('linkedin.com')) return path.startsWith('/company/');
    if (host.endsWith('facebook.com')) return path.startsWith('/pages') || path.includes('/pg/');
    if (host.endsWith('youtube.com')) return path.startsWith('/channel/') || path.startsWith('/c/');
    return false;
  } catch {
    return false;
  }
}

function evidenceEntry(field: string, value: string, sourceUrl: string, excerpt: string, retrievedAt: string) {
  return { field, value, sourceUrl, evidenceExcerpt: excerpt, retrievedAt, evidenceType: 'PUBLIC_WEB_SEARCH' };
}

export function companyDomainFromWebsite(website?: string | null): string | null {
  if (!website?.trim()) return null;
  try {
    const host = new URL(website.includes('://') ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}
