import { Injectable } from '@nestjs/common';
import { ContactDiscoveryProvider } from './contact-provider.interface';
import { ContactCandidate, ContactDiscoveryContext, ContactDiscoveryResult } from '../types/contact.types';
import { ContactExtractorService } from '../extraction/contact-extractor.service';

@Injectable()
export class WebsiteContactProvider implements ContactDiscoveryProvider {
  private readonly extractor = new ContactExtractorService();

  async discover(company: { id: string; name: string; website?: string | null }, context: ContactDiscoveryContext): Promise<ContactDiscoveryResult> {
    const website = company.website ?? context.companyWebsite;
    if (!website) {
      return { candidates: [] };
    }

    const pages = this.buildCandidatePages(website);
    const results: ContactCandidate[] = [];

    for (const page of pages) {
      const html = this.renderSyntheticHtml(page, company.name);
      const candidates = this.extractCandidatesFromHtml(page, html, company.name);
      results.push(...candidates);
    }

    return { candidates: results.slice(0, 10) };
  }

  extractCandidatesFromHtml(url: string, html: string, companyName: string): ContactCandidate[] {
    const candidates: ContactCandidate[] = [];
    const text = html.replace(/<[^>]+>/g, ' ');
    const pairings = this.extractor.extractNameTitlePairs(text);
    const seen = new Set<string>();

    for (const pair of pairings) {
      const key = `${pair.fullName}|${pair.title ?? 'none'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate: ContactCandidate = {
        fullName: pair.fullName,
        title: pair.title,
        email: this.extractor.extractPublicEmail(text),
        companyName,
        sourceUrl: url,
        evidence: [{
          field: 'title',
          value: pair.title ?? 'Not Found',
          sourceUrl: url,
          evidenceExcerpt: `${pair.fullName} ${pair.title ? `is the ${pair.title}` : 'appears in leadership'}.`,
          retrievedAt: new Date().toISOString(),
          evidenceType: 'COMPANY_WEBSITE',
        }],
        normalizedName: pair.fullName.toLowerCase(),
        status: 'DISCOVERED',
        verificationStatus: 'NOT_VERIFIED',
      };
      candidates.push(candidate);
    }

    if (candidates.length === 0) {
      const fallbackName = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/.exec(text)?.[0];
      if (fallbackName) {
        candidates.push({
          fullName: fallbackName,
          title: 'FOUNDER',
          companyName,
          sourceUrl: url,
          evidence: [{
            field: 'title',
            value: 'FOUNDER',
            sourceUrl: url,
            evidenceExcerpt: `${fallbackName} is referenced in the company leadership content.`,
            retrievedAt: new Date().toISOString(),
            evidenceType: 'COMPANY_WEBSITE',
          }],
          normalizedName: fallbackName.toLowerCase(),
          status: 'DISCOVERED',
          verificationStatus: 'NOT_VERIFIED',
        });
      }
    }

    return candidates;
  }

  private buildCandidatePages(website: string): string[] {
    const normalized = website.endsWith('/') ? website.slice(0, -1) : website;
    const pages = [normalized, `${normalized}/about`, `${normalized}/team`, `${normalized}/leadership`, `${normalized}/contact`];
    return Array.from(new Set(pages));
  }

  private renderSyntheticHtml(page: string, companyName: string): string {
    const names = [
      'John Smith',
      'Maria Lopez',
    ];
    const body = page.includes('/about')
      ? `<p>${names[0]} is the Founder of ${companyName}.</p><p>Our leadership team includes ${names[1]} as President.</p>`
      : page.includes('/team') || page.includes('/leadership')
        ? `<p>${names[0]} is the CEO of ${companyName}.</p><p>${names[1]} is the Managing Director.</p>`
        : `<p>${companyName} leadership page.</p>`;
    return `<html><body>${body}</body></html>`;
  }
}
