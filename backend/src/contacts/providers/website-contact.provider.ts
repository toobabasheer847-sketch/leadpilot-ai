import { Injectable } from '@nestjs/common';
import { WebsiteDiscoveryService } from '../../enrichment/website/website-discovery.service';
import { WebsiteNormalizerService } from '../../enrichment/website/website-normalizer.service';
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
    const result = await this.websiteDiscovery.discover(company.website ?? context.companyWebsite, company.name);
    const candidates = (result.pages ?? (result.page ? [result.page] : [])).flatMap((page) => this.extractCandidatesFromHtml(page.finalUrl, page.content, company.name));
    const unique = new Map<string, ContactCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.fullName.toLowerCase()}|${candidate.normalizedRole ?? candidate.title ?? ''}`;
      const existing = unique.get(key);
      if (existing) existing.evidence.push(...candidate.evidence);
      else unique.set(key, candidate);
    }
    return { candidates: [...unique.values()] };
  }

  extractCandidatesFromHtml(url: string, html: string, companyName: string): ContactCandidate[] {
    const text = this.stripHtml(html);
    const candidates: ContactCandidate[] = [];
    for (const pair of this.extractor.extractNameTitlePairs(text)) {
      if (!pair.title) continue;
      const nameIndex = text.toLowerCase().indexOf(pair.fullName.toLowerCase());
      if (nameIndex < 0) continue;
      const excerpt = text.slice(Math.max(0, nameIndex - 160), Math.min(text.length, nameIndex + pair.fullName.length + 220)).trim();
      const relationshipSupported = excerpt.toLowerCase().includes(companyName.toLowerCase()) || /\b(of|at|for)\b/i.test(excerpt);
      if (!relationshipSupported) continue;
      const email = this.extractor.extractPublicEmail(excerpt);
      const phone = this.extractor.extractPublicPhone(excerpt);
      const profiles = this.profileLinksForPerson(html, url, pair.fullName);
      const evidence = [
        this.extractor.buildEvidence('fullName', pair.fullName, url, 'COMPANY_WEBSITE', excerpt),
        this.extractor.buildEvidence('title', pair.originalTitle ?? pair.title, url, 'COMPANY_WEBSITE', excerpt),
        this.extractor.buildEvidence('companyRelationship', companyName, url, 'COMPANY_WEBSITE', excerpt),
      ];
      if (email) evidence.push(this.extractor.buildEvidence('email', email, url, 'COMPANY_WEBSITE', excerpt));
      if (phone) evidence.push(this.extractor.buildEvidence('phone', phone, url, 'COMPANY_WEBSITE', excerpt));
      for (const profile of profiles) evidence.push(this.extractor.buildEvidence('profileUrl', profile.url, url, 'COMPANY_WEBSITE', profile.excerpt));
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

  private profileLinksForPerson(html: string, sourceUrl: string, name: string) {
    const results: Array<{ url: string; excerpt: string }> = [];
    for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
      const start = Math.max(0, (match.index ?? 0) - 300);
      const excerpt = this.stripHtml(html.slice(start, (match.index ?? 0) + match[0].length + 300));
      if (!excerpt.toLowerCase().includes(name.toLowerCase())) continue;
      try {
        const resolved = new URL(match[1], sourceUrl);
        const host = resolved.hostname.toLowerCase();
        if (!['linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be'].some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
        const normalized = this.normalizer.normalizeUrl(resolved.toString());
        if (normalized) results.push({ url: normalized, excerpt });
      } catch { continue; }
    }
    return results;
  }

  private profileFields(profiles: Array<{ url: string; excerpt: string }>) {
    const fields: Pick<ContactCandidate, 'linkedinUrl' | 'facebookUrl' | 'instagramUrl' | 'youtubeUrl'> = {};
    for (const profile of profiles) {
      const host = new URL(profile.url).hostname;
      if (host.includes('linkedin')) fields.linkedinUrl = profile.url;
      else if (host.includes('facebook')) fields.facebookUrl = profile.url;
      else if (host.includes('instagram')) fields.instagramUrl = profile.url;
      else if (host.includes('youtube') || host.includes('youtu.be')) fields.youtubeUrl = profile.url;
    }
    return fields;
  }

  private stripHtml(html: string) {
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  }
}
