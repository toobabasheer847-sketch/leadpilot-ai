import { Injectable } from '@nestjs/common';
import type { CrossSourceEntityMatchResult, EntityMatchClaim, VerificationConflictLog } from '../types/verification.types';
import { ConflictEngineService } from '../conflict/conflict-engine.service';

@Injectable()
export class CrossSourceEntityMatcherService {
  constructor(private readonly conflicts: ConflictEngineService) {}

  match(claims: EntityMatchClaim[]): CrossSourceEntityMatchResult {
    if (claims.length < 2) {
      return { sameEntity: true, confidence: claims.length === 1 ? 0.6 : 0, signals: claims.length ? ['single source'] : ['no sources'], conflicts: [] };
    }

    const uniqueUrls = new Set(claims.map((claim) => this.canonicalUrl(claim.sourceUrl)));
    const independent = claims.filter((claim, index, all) => all.findIndex((row) => this.canonicalUrl(row.sourceUrl) === this.canonicalUrl(claim.sourceUrl) && row.sourceType === claim.sourceType) === index);
    const signals: string[] = [];
    const conflictLogs: VerificationConflictLog[] = [];

    if (uniqueUrls.size < claims.length) signals.push('duplicate source urls collapsed');

    const names = this.distinct(independent.map((claim) => claim.name).filter(Boolean).map((value) => value!.toLowerCase().trim()));
    const websites = this.distinct(independent.map((claim) => this.canonicalUrl(claim.website)).filter(Boolean) as string[]);
    const phones = this.distinct(independent.map((claim) => claim.phone?.replace(/\D/g, '')).filter(Boolean) as string[]);

    if (names.length === 1) signals.push('matching company name');
    if (websites.length === 1) signals.push('matching website');
    if (phones.length === 1) signals.push('matching phone');

    if (names.length > 1) {
      conflictLogs.push(this.conflicts.buildConflict('companyName', {
        value: names[0], sourceType: independent[0].sourceType, sourceUrl: independent[0].sourceUrl, retrievedAt: independent[0].retrievedAt, evidenceExcerpt: names[0],
      }, {
        value: names[1], sourceType: independent[1]?.sourceType ?? independent[0].sourceType, sourceUrl: independent[1]?.sourceUrl ?? independent[0].sourceUrl, retrievedAt: independent[1]?.retrievedAt ?? independent[0].retrievedAt, evidenceExcerpt: names[1],
      }));
    }
    if (websites.length > 1) {
      conflictLogs.push(this.conflicts.buildConflict('website', {
        value: websites[0], sourceType: independent[0].sourceType, sourceUrl: independent[0].sourceUrl, retrievedAt: independent[0].retrievedAt, evidenceExcerpt: websites[0],
      }, {
        value: websites[1], sourceType: independent[1]?.sourceType ?? independent[0].sourceType, sourceUrl: independent[1]?.sourceUrl ?? independent[0].sourceUrl, retrievedAt: independent[1]?.retrievedAt ?? independent[0].retrievedAt, evidenceExcerpt: websites[1],
      }));
    }
    if (phones.length > 1) {
      conflictLogs.push(this.conflicts.buildConflict('phone', {
        value: phones[0], sourceType: independent[0].sourceType, sourceUrl: independent[0].sourceUrl, retrievedAt: independent[0].retrievedAt, evidenceExcerpt: phones[0],
      }, {
        value: phones[1], sourceType: independent[1]?.sourceType ?? independent[0].sourceType, sourceUrl: independent[1]?.sourceUrl ?? independent[0].sourceUrl, retrievedAt: independent[1]?.retrievedAt ?? independent[0].retrievedAt, evidenceExcerpt: phones[1],
      }));
    }

    const agreementScore = Number(names.length <= 1) * 0.4 + Number(websites.length <= 1) * 0.35 + Number(phones.length <= 1) * 0.25;
    const sameEntity = conflictLogs.length === 0 && (names.length <= 1 || websites.length === 1 || phones.length === 1);
    return {
      sameEntity,
      confidence: Number(agreementScore.toFixed(2)),
      signals,
      conflicts: conflictLogs,
    };
  }

  extractClaim(sourceRecord: { id: string; sourceType: string; sourceUrl: string; retrievedAt: Date; rawData: unknown }): EntityMatchClaim {
    const raw = typeof sourceRecord.rawData === 'object' && sourceRecord.rawData !== null ? sourceRecord.rawData as Record<string, unknown> : {};
    return {
      sourceRecordId: sourceRecord.id,
      sourceType: sourceRecord.sourceType,
      sourceUrl: sourceRecord.sourceUrl,
      retrievedAt: sourceRecord.retrievedAt,
      name: this.stringField(raw, ['name', 'displayName', 'companyName', 'title']),
      website: this.stringField(raw, ['website', 'websiteUri', 'url', 'domain']),
      phone: this.stringField(raw, ['phone', 'nationalPhoneNumber', 'internationalPhoneNumber', 'formattedPhoneNumber']),
    };
  }

  private stringField(raw: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private canonicalUrl(value?: string | null) {
    if (!value) return null;
    try {
      const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      parsed.hash = '';
      parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      return `${parsed.protocol}//${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return value.toLowerCase().trim();
    }
  }

  private distinct(values: string[]) {
    return [...new Set(values)];
  }
}
