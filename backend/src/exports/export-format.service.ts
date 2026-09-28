import { Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import type { ExportField } from './types/export.types';

@Injectable()
export class ExportFormatService {
  headers(fields: ExportField[]) { return fields; }

  toRows(leads: Array<Record<string, unknown>>, fields: ExportField[]) {
    return leads.map((lead) => fields.map((field) => this.safeCell(this.valueFor(lead, field))));
  }

  csv(fields: ExportField[], rows: string[][]) {
    return Buffer.from([fields, ...rows].map((row) => row.map((value) => this.escapeCsv(value)).join(',')).join('\r\n') + '\r\n', 'utf8');
  }

  xlsx(fields: ExportField[], rows: string[][]) {
    const worksheet = XLSX.utils.aoa_to_sheet([fields, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  private valueFor(lead: Record<string, unknown>, field: ExportField): unknown {
    const company = this.record(lead.company);
    const contact = this.record(lead.contact);
    const location = this.record(company.location);
    const classification = this.record(lead.classification);
    const score = this.record(lead.score);
    const qualification = this.record(lead.qualification);
    const size = (value: unknown) => this.present(value, 'UNKNOWN');
    const found = (value: unknown) => this.present(value, 'NOT_FOUND');
    const mapping: Record<ExportField, unknown> = {
      companyName: found(company.name), website: found(company.website), domain: found(company.domain), companyPhone: found(company.phone), companyEmail: found(company.email),
      address: found(location.address), city: found(location.city), state: found(location.state), zipCode: found(location.zipCode), country: found(location.country),
      employeeCount: size(company.employeeCount ?? (typeof company.companySize === 'number' ? company.companySize : null)),
      employeeRange: size(company.employeeRange ?? (typeof company.companySize === 'string' && company.companySize !== 'CONFLICT' && company.companySize.includes('-') ? company.companySize : null)),
      companySizeStatus: size(company.companySizeStatus),
      contactName: found(contact.name), contactTitle: found(contact.title), contactEmail: found(contact.email), contactPhone: found(contact.phone),
      linkedin: found(contact.linkedin), facebook: found(contact.facebook), instagram: found(contact.instagram),
      decisionMakerLinkedin: found(contact.linkedin), decisionMakerFacebook: found(contact.facebook), decisionMakerInstagram: found(contact.instagram), decisionMakerYoutube: found(contact.youtube), decisionMakerX: found(contact.twitter),
      companyLinkedin: this.companySocial(lead, 'linkedin'), companyFacebook: this.companySocial(lead, 'facebook'), companyInstagram: this.companySocial(lead, 'instagram'), companyYoutube: this.companySocial(lead, 'youtube'), companyX: this.companySocial(lead, 'x'),
      investorType: found(company.investorType), investmentStrategy: found(company.investmentStrategy), propertyType: found(this.stringify(company.propertyTypes)), marketsServed: found(this.stringify(company.marketsServed)), companySize: size(company.companySize),
      classification: found(classification.decision), classificationConfidence: found(classification.confidence), score: found(score.value), scoreBand: found(score.band),
      qualificationStatus: found(qualification.status), verificationStatus: found(this.record(lead.verification).status), evidence: found(this.stringify(lead.evidence)), sourceUrls: found(this.stringify(lead.sourceUrls)), duplicateStatus: found(this.record(lead.duplicate).status),
      createdAt: found(lead.createdAt), updatedAt: found(lead.updatedAt), lastVerifiedAt: found(lead.lastVerifiedAt ?? company.lastVerifiedAt),
    };
    return mapping[field] ?? 'NOT_FOUND';
  }

  private present(value: unknown, missing: 'NOT_FOUND' | 'UNKNOWN'): unknown {
    if (value === null || value === undefined || value === '') return missing;
    return value;
  }

  private companySocial(lead: Record<string, unknown>, platform: string): unknown {
    const profiles = Array.isArray(lead.socialProfiles) ? lead.socialProfiles : [];
    const match = profiles.find((item) => {
      if (!item || typeof item !== 'object' || !('platform' in item)) return false;
      const name = String(item.platform).toLowerCase();
      return name === platform || (platform === 'x' && name === 'twitter');
    }) as { profileUrl?: unknown } | undefined;
    return this.present(match?.profileUrl, 'NOT_FOUND');
  }

  private safeCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : JSON.stringify(value) ?? '';
    return /^(=|\+|-|@)/.test(text) ? `'${text}` : text;
  }

  private escapeCsv(value: string) { const escaped = value.replace(/"/g, '""'); return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped; }
  private record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}; }
  private stringify(value: unknown) { return value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value); }
}
