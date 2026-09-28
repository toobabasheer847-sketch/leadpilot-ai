import { Injectable } from '@nestjs/common';
import { WebsiteDiscoveryService } from '../../enrichment/website/website-discovery.service';
import { WebsiteNormalizerService } from '../../enrichment/website/website-normalizer.service';
import { isPersonProfileUrl, roleMatches } from '../discovery/public-decision-maker';
import { ContactExtractorService } from '../extraction/contact-extractor.service';
import { ContactCandidate, ContactDiscoveryContext, ContactDiscoveryResult } from '../types/contact.types';
import { ContactDiscoveryProvider } from './contact-provider.interface';

@Injectable()
export class WebsiteContactProvider implements ContactDiscoveryProvider {
  constructor(
    private readonly extractor: ContactExtractorService,
    private readonly websiteDiscovery: WebsiteDiscoveryService,
    private readonly normalizer: WebsiteNormalizerService,
  ) {}

  async discover(company: { id: string; name: string; website?: string | null }, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    // Prefer the known official website so Phase D does not re-run web-search website discovery.
    const result = await this.websiteDiscovery.discover(company.website ?? context.companyWebsite, company.name);
    const roles = context.decisionMakerRoles;
    const candidates = (result.pages ?? (result.page ? [result.page] : [])).flatMap((page) => this.extractCandidatesFromHtml(page.finalUrl, page.content, company.name, roles));
    const unique = new Map<string, ContactCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.fullName.toLowerCase()}|${candidate.normalizedRole ?? candidate.title ?? ''}`;
      const existing = unique.get(key);
      if (existing) existing.evidence.push(...candidate.evidence);
      else unique.set(key, candidate);
    }
    return { candidates: [...unique.values()] };
  }

  extractCandidatesFromHtml(url: string, html: string, companyName: string, targetRoles?: string[]): ContactCandidate[] {
    const text = this.stripHtml(html);
    const candidates: ContactCandidate[] = [];
    for (const pair of this.extractor.extractNameTitlePairs(text, targetRoles)) {
      if (!pair.title) continue;
      if (targetRoles?.length && !roleMatches(pair.originalTitle ?? pair.title, targetRoles) && !roleMatches(pair.title, targetRoles)) continue;
      const nameIndex = text.toLowerCase().indexOf(pair.fullName.toLowerCase());
      if (nameIndex < 0) continue;
      const excerpt = text.slice(Math.max(0, nameIndex - 160), Math.min(text.length, nameIndex + pair.fullName.length + 220)).trim();
      if (!this.companyRelationshipSupported(excerpt, companyName)) continue;
      const email = this.extractor.extractPublicEmail(excerpt);
      const phone = this.extractor.extractPublicPhone(excerpt);
      const profiles = this.profileLinksForPerson(html, url, pair.fullName);
      const evidenceType = this.evidenceTypeForUrl(url);
      const evidence = [
        this.extractor.buildEvidence('fullName', pair.fullName, url, evidenceType, excerpt),
        this.extractor.buildEvidence('title', pair.originalTitle ?? pair.title, url, evidenceType, excerpt),
        this.extractor.buildEvidence('companyRelationship', companyName, url, evidenceType, excerpt),
      ];
      if (email) evidence.push(this.extractor.buildEvidence('email', email, url, evidenceType, excerpt));
      if (phone) evidence.push(this.extractor.buildEvidence('phone', phone, url, evidenceType, excerpt));
      for (const profile of profiles) evidence.push(this.extractor.buildEvidence('profileUrl', profile.url, url, evidenceType, profile.excerpt));
      candidates.push({
        fullName: pair.fullName,
        originalTitle: pair.originalTitle,
        title: pair.originalTitle ?? pair.title,
        normalizedRole: pair.title,
        companyRelationship: companyName,
        email,
        emailStatus: email ? 'FOUND' : 'NOT_FOUND',
        phone,
        phoneStatus: phone ? 'FOUND' : 'NOT_FOUND',
        ...this.profileFields(profiles),
        companyName,
        sourceUrl: url,
        evidence,
        normalizedName: pair.fullName.toLowerCase(),
        status: 'DISCOVERED',
        verificationStatus: 'NOT_VERIFIED',
      });
    }
    return candidates;
  }

  private companyRelationshipSupported(excerpt: string, companyName: string): boolean {
    const lower = excerpt.toLowerCase();
    const normalized = companyName.trim().toLowerCase();
    if (normalized.length >= 3 && lower.includes(normalized)) return true;
    const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['investments', 'investment', 'capital', 'group', 'partners', 'properties', 'company', 'holdings', 'inc', 'llc'].includes(token));
    return tokens.length > 0 && tokens.every((token) => lower.includes(token));
  }

  private evidenceTypeForUrl(url: string): string {
    const path = (() => {
      try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); }
    })();
    if (/\/(team|our-team|leadership|management)\b/.test(path)) return 'WEBSITE_TEAM_PAGE';
    if (/\/(about|about-us|company)\b/.test(path)) return 'WEBSITE_ABOUT_PAGE';
    if (/\/contact\b/.test(path)) return 'WEBSITE_CONTACT_PAGE';
    return 'COMPANY_WEBSITE';
  }

  private profileLinksForPerson(html: string, sourceUrl: string, name: string) {
    const results: Array<{ url: string; excerpt: string }> = [];
    for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
      const start = Math.max(0, (match.index ?? 0) - 300);
      const excerpt = this.stripHtml(html.slice(start, (match.index ?? 0) + match[0].length + 300));
      if (!excerpt.toLowerCase().includes(name.toLowerCase())) continue;
      try {
        const resolved = new URL(match[1], sourceUrl);
        if (!isPersonProfileUrl(resolved.toString())) continue;
        const normalized = this.normalizer.normalizeUrl(resolved.toString());
        if (normalized) results.push({ url: normalized, excerpt });
      } catch { continue; }
    }
    return results;
  }

  private profileFields(profiles: Array<{ url: string; excerpt: string }>) {
    const fields: Pick<ContactCandidate, 'linkedinUrl' | 'facebookUrl' | 'instagramUrl' | 'youtubeUrl' | 'twitterUrl'> = {};
    for (const profile of profiles) {
      const host = new URL(profile.url).hostname;
      if (host.includes('linkedin')) fields.linkedinUrl = profile.url;
      else if (host.includes('facebook')) fields.facebookUrl = profile.url;
      else if (host.includes('instagram')) fields.instagramUrl = profile.url;
      else if (host.includes('youtube') || host.includes('youtu.be')) fields.youtubeUrl = profile.url;
      else if (host.includes('twitter') || host === 'x.com' || host.endsWith('.x.com')) fields.twitterUrl = profile.url;
    }
    return fields;
  }

  private stripHtml(html: string) {
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  }
}
