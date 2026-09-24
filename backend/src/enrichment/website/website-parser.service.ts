import { Injectable } from '@nestjs/common';
import { ExtractedCompanyFields, SourceEvidence } from './website.types';

@Injectable()
export class WebsiteParserService {
  parsePage(url: string, html: string): ExtractedCompanyFields {
    const text = this.stripHtml(html);
    const title = this.extractTitle(html);
    const description = this.extractMetaDescription(html) ?? this.extractDescriptionFromText(text);
    const email = this.extractPublicEmail(text, html);
    const phone = this.extractPhone(text);
    const address = this.extractAddress(text, html);
    const socialLinks = this.extractSocialLinks(html);
    const investmentSignals = this.extractInvestmentSignals(text);
    const services = this.extractListItems(text, ['services', 'solutions', 'what we do']);
    const marketsServed = this.extractListItems(text, ['markets served', 'areas served', 'geographies']);
    const propertyTypes = this.extractListItems(text, ['property types', 'properties', 'portfolio']);

    const evidence: SourceEvidence[] = [];
    if (description) {
      evidence.push({
        field: 'description',
        value: description,
        sourceUrl: url,
        evidenceExcerpt: this.trimExcerpt(description),
        retrievedAt: new Date().toISOString(),
        evidenceType: 'WEBSITE',
      });
    }
    if (email) {
      evidence.push({
        field: 'publicEmail',
        value: email,
        sourceUrl: url,
        evidenceExcerpt: email,
        retrievedAt: new Date().toISOString(),
        evidenceType: 'CONTACT_PAGE',
      });
    }
    if (phone) {
      evidence.push({
        field: 'phone',
        value: phone,
        sourceUrl: url,
        evidenceExcerpt: phone,
        retrievedAt: new Date().toISOString(),
        evidenceType: 'CONTACT_PAGE',
      });
    }

    return {
      companyName: title ?? null,
      description: description ?? null,
      phone: phone ?? null,
      publicEmail: email ?? null,
      address: address ?? null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      services,
      marketsServed,
      propertyTypes,
      investmentStrategy: investmentSignals[0] ?? null,
      socialLinks,
      investmentSignals,
      evidence,
    };
  }

  stripHtml(html: string): string {
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? this.cleanText(match[1]) || null : null;
  }

  extractMetaDescription(html: string): string | null {
    const pattern = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i;
    const direct = html.match(pattern);
    if (direct) {
      return this.cleanText(direct[1]) || null;
    }
    const fallback = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
    return fallback ? this.cleanText(fallback[1]) || null : null;
  }

  extractDescriptionFromText(text: string): string | null {
    if (!text) {
      return null;
    }
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    return sentences.slice(0, 2).join(' ').slice(0, 300) || null;
  }

  extractPublicEmail(text: string, html: string): string | null {
    const candidates = [...text.matchAll(/(?:mailto:)?([A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/gi)].map((match) => match[1].toLowerCase());
    const allowed = ['info', 'contact', 'hello', 'support', 'sales', 'team', 'press', 'careers'];
    const selected = candidates.find((value) => {
      const local = value.split('@')[0].toLowerCase();
      return allowed.some((prefix) => local === prefix || local.startsWith(`${prefix}.`) || local.startsWith(`${prefix}+`));
    }) ?? candidates[0] ?? null;

    if (html.toLowerCase().includes('mailto:john@') || html.toLowerCase().includes('mailto:jane@')) {
      return selected;
    }

    return selected;
  }

  extractPhone(text: string): string | null {
    const match = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
    return match ? match[0].replace(/\s+/g, ' ').trim() : null;
  }

  extractAddress(text: string, html: string): string | null {
    const structured = html.match(/"address"\s*:\s*\{[\s\S]*?"streetAddress"\s*:\s*"([^"]+)"/i);
    if (structured) {
      return this.cleanText(structured[1]);
    }
    const match = text.match(/([0-9]+\s+[A-Za-z0-9.#\- ]+,?\s+[A-Za-z0-9.#\- ]+,?\s+[A-Za-z]{2,}\s+\d{5})/i);
    return match ? this.cleanText(match[1]) : null;
  }

  extractSocialLinks(html: string): string[] {
    const links = new Set<string>();
    const matches = html.matchAll(/href=["']([^"']+)["']/gi);
    for (const match of matches) {
      const href = match[1];
      const candidate = this.normalizeUrl(href);
      if (!candidate) {
        continue;
      }
      const lower = candidate.toLowerCase();
      if (lower.includes('linkedin.com') || lower.includes('facebook.com') || lower.includes('instagram.com') || lower.includes('x.com') || lower.includes('twitter.com') || lower.includes('youtube.com')) {
        links.add(candidate);
      }
    }
    return Array.from(links);
  }

  extractInvestmentSignals(text: string): string[] {
    const patterns = [
      /we buy houses? for cash/i,
      /buy and hold/i,
      /fix and flip/i,
      /brrrrr/i,
      /distressed properties?/i,
      /commercial property acquisition/i,
      /land acquisition/i,
      /we purchase distressed properties?/i,
    ];
    const matches = new Set<string>();
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        matches.add(match[0]);
      }
    }
    return Array.from(matches);
  }

  extractListItems(text: string, names: string[]): string[] {
    const lower = text.toLowerCase();
    const results: string[] = [];
    for (const name of names) {
      const index = lower.indexOf(name);
      if (index >= 0) {
        const snippet = text.slice(index, index + 220);
        const cleaned = this.cleanText(snippet).replace(new RegExp(`^${name}`, 'i'), '').replace(/\s+/g, ' ').trim();
        if (cleaned) {
          results.push(cleaned);
        }
      }
    }
    return results;
  }

  private cleanText(value: string): string {
    return value
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  private trimExcerpt(value: string): string {
    return value.length > 180 ? `${value.slice(0, 180).trim()}...` : value;
  }

  private normalizeUrl(candidate: string): string | null {
    try {
      const trimmed = candidate.trim();
      if (!trimmed || trimmed.startsWith('javascript:')) {
        return null;
      }
      const safe = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const parsed = new URL(safe);
      return parsed.toString();
    } catch {
      return null;
    }
  }
}
