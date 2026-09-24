import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactEvidenceEntry, ContactStatus, VerificationStatus } from '../types/contact.types';

@Injectable()
export class ContactExtractorService {
  constructor(private readonly config: ConfigService) {}

  normalizeTitle(rawTitle: string | null): string | null {
    if (!rawTitle) return null;
    const cleaned = rawTitle.trim();
    if (!cleaned) return null;

    const normalized = cleaned.replace(/\s+/g, ' ').replace(/\./g, '').trim();
    const map: Record<string, string> = {
      'Chief Executive Officer': 'CEO',
      'Chief Executive': 'CEO',
      'Co-Founder': 'CO_FOUNDER',
      'Managing Director': 'MANAGING_DIRECTOR',
      'Managing Partner': 'MANAGING_PARTNER',
      'Partner': 'PARTNER',
      'Director': 'DIRECTOR',
      'General Manager': 'GENERAL_MANAGER',
      'Founding Partner': 'FOUNDER',
      'Founder': 'FOUNDER',
      'President': 'PRESIDENT',
      'Owner': 'OWNER',
      'Principal': 'PRINCIPAL',
      'Manager': 'MANAGER',
    };

    const exact = map[normalized];
    if (exact) return exact;

    const upper = normalized.toUpperCase();
    if (upper.includes('CEO')) return 'CEO';
    if (upper.includes('FOUNDER')) return 'FOUNDER';
    if (upper.includes('CO-FOUNDER') || upper.includes('COFOUNDER')) return 'CO_FOUNDER';
    if (upper.includes('PRESIDENT')) return 'PRESIDENT';
    if (upper.includes('OWNER')) return 'OWNER';
    if (upper.includes('MANAGING DIRECTOR')) return 'MANAGING_DIRECTOR';
    if (upper.includes('MANAGING PARTNER')) return 'MANAGING_PARTNER';
    if (upper.includes('PARTNER')) return 'PARTNER';
    if (upper.includes('DIRECTOR')) return 'DIRECTOR';
    if (upper.includes('GENERAL MANAGER')) return 'GENERAL_MANAGER';
    if (upper.includes('PRINCIPAL')) return 'PRINCIPAL';
    if (upper.includes('MANAGER') && !upper.includes('SALES')) return 'MANAGER';
    return normalized;
  }

  normalizeName(name: string): string {
    const stopWords = ['ABOUT', 'OUR', 'THE', 'TEAM', 'LEADERSHIP', 'CONTACT', 'HOME', 'WELCOME', 'SERVICES', 'INDUSTRIES', 'COMPANY', 'PAGE'];
    const cleaned = name.replace(/\s+/g, ' ').trim();
    const parts = cleaned.split(/\s+/);
    while (parts.length > 0 && stopWords.includes(parts[0].toUpperCase())) {
      parts.shift();
    }
    if (parts.length === 0) return cleaned;
    return parts.join(' ');
  }

  buildEvidence(field: string, value: string, sourceUrl: string, evidenceType: string, evidenceExcerpt?: string): ContactEvidenceEntry {
    return {
      field,
      value,
      sourceUrl,
      evidenceExcerpt: evidenceExcerpt ?? value,
      retrievedAt: new Date().toISOString(),
      evidenceType,
    };
  }

  extractPublicEmail(text: string): string | null {
    const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (!match) return null;
    const value = match[0];
    const local = value.split('@')[0].toLowerCase();
    const blocked = ['john', 'jane', 'info', 'contact', 'hello', 'support', 'sales'];
    if (blocked.includes(local) || value.includes('example.com')) {
      return null;
    }
    return value;
  }

  extractPublicPhone(text: string): string | null {
    const match = text.match(/(?:\+?\d{1,3}[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}/);
    return match?.[0]?.trim() ?? null;
  }

  extractNameTitlePairs(text: string): Array<{ fullName: string; title: string | null; originalTitle: string | null }> {
    const pairs: Array<{ fullName: string; title: string | null; originalTitle: string | null }> = [];
    const nameRegex = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
    const names = Array.from(new Set((text.match(nameRegex) ?? [])
      .map((name) => this.normalizeName(name.trim()))
      .filter((name) => name && !/^\d+$/.test(name))));
    const configuredRoles = this.config.get<string[]>('decisionMaker.rolePriorities', []);
    const titlePriority = configuredRoles.length ? configuredRoles : ['CEO', 'FOUNDER', 'CO_FOUNDER', 'PRESIDENT', 'OWNER', 'MANAGING_PARTNER', 'PARTNER', 'PRINCIPAL', 'MANAGING_DIRECTOR', 'DIRECTOR', 'GENERAL_MANAGER', 'MANAGER'];

    for (const name of names) {
      const lowerText = text.toLowerCase();
      const normalizedName = name.toLowerCase();
      const idx = lowerText.indexOf(normalizedName);
      if (idx === -1) continue;
      const before = text.slice(Math.max(0, idx - 120), idx);
      const after = text.slice(idx + name.length, idx + name.length + 180);
      const combined = `${before} ${after}`.toLowerCase();
      const matchedTitles = titlePriority.filter((title) => combined.includes(title.toLowerCase()));
      if (matchedTitles.length === 0) {
        pairs.push({ fullName: this.normalizeName(name), title: null, originalTitle: null });
        continue;
      }
      for (const title of matchedTitles) {
        pairs.push({ fullName: this.normalizeName(name), title: this.normalizeTitle(title), originalTitle: title });
      }
    }
    return pairs;
  }

  chooseStatus(verificationStatus: VerificationStatus): ContactStatus {
    if (verificationStatus === 'VERIFIED') return 'VERIFIED';
    if (verificationStatus === 'SUPPORTED') return 'PARTIALLY_VERIFIED';
    if (verificationStatus === 'CONFLICT' || verificationStatus === 'NEEDS_REVIEW') return 'NOT_VERIFIED';
    if (verificationStatus === 'NOT_FOUND') return 'NOT_FOUND';
    return 'DISCOVERED';
  }
}
