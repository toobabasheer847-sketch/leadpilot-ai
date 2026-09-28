import { Injectable } from '@nestjs/common';
import { isCompanyProfileUrl } from '../../contacts/discovery/public-decision-maker';
import { WebsiteNormalizerService } from '../website/website-normalizer.service';

@Injectable()
export class CompanySocialDiscoveryService {
  constructor(private readonly normalizer: WebsiteNormalizerService) {}

  discover(html: string, baseUrl: string): string[] {
    const urls = new Set<string>();
    const matches = html.matchAll(/href=["']([^"']+)["']/gi);

    for (const match of matches) {
      const candidate = this.normalizeCandidate(match[1], baseUrl);
      if (!candidate) {
        continue;
      }
      const lower = candidate.toLowerCase();
      if (lower.includes('linkedin.com')) {
        urls.add(candidate);
      }
      if (lower.includes('facebook.com')) {
        urls.add(candidate);
      }
      if (lower.includes('instagram.com')) {
        urls.add(candidate);
      }
      if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
        urls.add(candidate);
      }
      if (lower.includes('x.com') || lower.includes('twitter.com')) {
        urls.add(candidate);
      }
    }

    return Array.from(urls);
  }

  fromSearchHits(companyName: string, hits: Array<{ url: string; title?: string; snippet?: string }>): string[] {
    return publicCompanyProfiles(companyName, hits);
  }

  private normalizeCandidate(candidate: string, baseUrl: string): string | null {
    if (!candidate || candidate.startsWith('javascript:')) {
      return null;
    }

    try {
      const resolved = new URL(candidate, baseUrl);
      const host = resolved.hostname.toLowerCase();
      const allowed = ['linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'x.com', 'twitter.com', 'youtu.be'];
      if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return null;
      }
      resolved.hash = '';
      const normalized = this.normalizer.normalizeUrl(resolved.toString());
      return normalized ?? null;
    } catch {
      return null;
    }
  }
}

const PROFILE_HOST = /(?:^|\.)((?:linkedin|facebook|instagram|youtube|twitter)\.com|x\.com|youtu\.be)$/i;

/** A public company profile from a search hit. Person profiles and posts are left out. */
export function publicCompanyProfiles(companyName: string, hits: Array<{ url: string; title?: string; snippet?: string }>): string[] {
  const name = companyName.trim();
  if (name.length < 3) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const text = `${hit.title ?? ''} ${hit.snippet ?? ''}`;
    if (!text.toLowerCase().includes(name.toLowerCase())) continue;
    if (profileBelongsToOtherCompany(name, hit.title ?? '', hit.snippet ?? '')) continue;
    const url = canonicalProfileUrl(hit.url);
    if (!url || seen.has(url) || !isPublicCompanyProfile(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found;
}

function profileBelongsToOtherCompany(companyName: string, title: string, snippet: string): boolean {
  const subject = title.split(/\s+[|–—]\s+|\s+-\s+/)[0]?.trim() ?? '';
  if (!subject) return false;
  const target = normalizeName(companyName);
  const candidate = normalizeName(subject);
  if (!candidate || candidate.includes(target) || target.includes(candidate)) return false;
  const targetTokens = distinctiveTokens(target);
  const candidateTokens = distinctiveTokens(candidate);
  if (!targetTokens.length || !candidateTokens.length) return false;
  const shared = targetTokens.filter((token) => candidateTokens.includes(token));
  if (shared.length === 0) return false;
  if (candidateTokens.some((token) => !targetTokens.includes(token))) return true;
  const text = normalizeName(`${title} ${snippet}`);
  return !text.includes(target);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function distinctiveTokens(value: string): string[] {
  const legal = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd', 'limited', 'company', 'lp', 'llp', 'pllc', 'plc', 'and', 'the', 'for']);
  return value.split(' ').filter((token) => token.length >= 3 && !legal.has(token));
}

function isPublicCompanyProfile(url: string): boolean {
  if (isCompanyProfileUrl(url)) return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!PROFILE_HOST.test(host) || parts.length !== 1) return false;
    const segment = parts[0].toLowerCase();
    if (['share', 'sharer', 'login', 'search', 'intent', 'explore', 'watch', 'people', 'groups', 'profile.php', 'status', 'posts'].includes(segment)) return false;
    if (host.endsWith('linkedin.com')) return false;
    if (host.endsWith('youtube.com') || host === 'youtu.be') return segment.startsWith('@');
    return true;
  } catch {
    return false;
  }
}

function canonicalProfileUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
