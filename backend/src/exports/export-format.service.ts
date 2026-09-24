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
    const mapping: Record<ExportField, unknown> = {
      companyName: company.name, website: company.website, domain: company.domain, companyPhone: company.phone, companyEmail: company.email,
      address: location.address, city: location.city, state: location.state, zipCode: location.zipCode, country: location.country,
      contactName: contact.name, contactTitle: contact.title, contactEmail: contact.email, contactPhone: contact.phone,
      linkedin: contact.linkedin, facebook: contact.facebook, instagram: contact.instagram,
      investorType: company.investorType, investmentStrategy: company.investmentStrategy, propertyType: this.stringify(company.propertyTypes), marketsServed: this.stringify(company.marketsServed), companySize: company.companySize,
      classification: classification.decision, classificationConfidence: classification.confidence, score: score.value, scoreBand: score.band,
      qualificationStatus: qualification.status, verificationStatus: this.record(lead.verification).status, evidence: this.stringify(lead.evidence), sourceUrls: this.stringify(lead.sourceUrls), duplicateStatus: this.record(lead.duplicate).status,
      createdAt: lead.createdAt, updatedAt: lead.updatedAt, lastVerifiedAt: lead.lastVerifiedAt ?? company.lastVerifiedAt,
    };
    return mapping[field] ?? null;
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
