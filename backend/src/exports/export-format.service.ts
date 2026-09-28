import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { displayHeaders } from './plan-export-columns';
import { escapeCsvCell, sanitizeExportCell } from './sanitize-export-cell';
import type { ExportField, MissingValueMode } from './types/export.types';

@Injectable()
export class ExportFormatService {
  headers(fields: ExportField[], friendly = true) {
    return friendly ? displayHeaders(fields) : fields;
  }

  toRows(leads: Array<Record<string, unknown>>, fields: ExportField[], missing: MissingValueMode = 'NOT_FOUND') {
    return leads.map((lead) => fields.map((field) => sanitizeExportCell(this.valueFor(lead, field, missing), { missing, dateStyle: 'friendly' })));
  }

  csv(fields: ExportField[], rows: string[][], friendlyHeaders = true) {
    const header = this.headers(fields, friendlyHeaders);
    return Buffer.from([header, ...rows].map((row) => row.map((value) => escapeCsvCell(value)).join(',')).join('\r\n') + '\r\n', 'utf8');
  }

  csvRows(rows: string[][]) {
    if (!rows.length) return Buffer.alloc(0);
    return Buffer.from(rows.map((row) => row.map((value) => escapeCsvCell(value)).join(',')).join('\r\n') + '\r\n', 'utf8');
  }

  async xlsx(fields: ExportField[], rows: string[][], friendlyHeaders = true): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LeadPilot';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
    const header = this.headers(fields, friendlyHeaders);
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle', wrapText: true };
    for (const row of rows) {
      const added = sheet.addRow(row);
      added.alignment = { vertical: 'top', wrapText: true };
    }
    for (let index = 0; index < header.length; index += 1) {
      const column = sheet.getColumn(index + 1);
      let width = header[index]?.length ?? 10;
      for (const row of rows) {
        const cell = row[index] ?? '';
        width = Math.max(width, Math.min(cell.length, 48));
      }
      column.width = Math.min(Math.max(width + 2, 12), 50);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private valueFor(lead: Record<string, unknown>, field: ExportField, missing: MissingValueMode): unknown {
    const company = this.record(lead.company);
    const contact = this.record(lead.contact);
    const location = this.record(company.location);
    const classification = this.record(lead.classification);
    const score = this.record(lead.score);
    const qualification = this.record(lead.qualification);
    const size = (value: unknown) => this.present(value, missing === 'EMPTY' ? '' : 'UNKNOWN');
    const found = (value: unknown) => this.present(value, missing === 'EMPTY' ? '' : 'NOT_FOUND');
    const mapping: Record<ExportField, unknown> = {
      companyName: found(company.name), website: found(company.website), domain: found(company.domain), companyPhone: found(company.phone), companyEmail: found(company.email),
      address: found(location.address), city: found(location.city), state: found(location.state), zipCode: found(location.zipCode), country: found(location.country),
      employeeCount: size(company.employeeCount ?? (typeof company.companySize === 'number' ? company.companySize : null)),
      employeeRange: size(company.employeeRange ?? (typeof company.companySize === 'string' && company.companySize !== 'CONFLICT' && company.companySize.includes('-') ? company.companySize : null)),
      companySizeStatus: size(company.companySizeStatus),
      contactName: found(contact.name), contactTitle: found(contact.title), contactEmail: found(contact.email), contactPhone: found(contact.phone),
      linkedin: found(contact.linkedin), facebook: found(contact.facebook), instagram: found(contact.instagram),
      decisionMakerLinkedin: found(contact.linkedin), decisionMakerFacebook: found(contact.facebook), decisionMakerInstagram: found(contact.instagram), decisionMakerYoutube: found(contact.youtube), decisionMakerX: found(contact.twitter),
      companyLinkedin: this.companySocial(lead, 'linkedin', missing), companyFacebook: this.companySocial(lead, 'facebook', missing), companyInstagram: this.companySocial(lead, 'instagram', missing), companyYoutube: this.companySocial(lead, 'youtube', missing), companyX: this.companySocial(lead, 'x', missing),
      investorType: found(company.investorType), investmentStrategy: found(company.investmentStrategy), propertyType: found(this.stringify(company.propertyTypes)), marketsServed: found(this.stringify(company.marketsServed)), companySize: size(company.companySize),
      classification: found(classification.decision), classificationConfidence: found(classification.confidence), score: found(score.value), scoreBand: found(score.band),
      qualificationStatus: found(qualification.status),
      qualificationReason: found(this.qualificationReason(qualification)),
      verificationStatus: found(this.record(lead.verification).status), evidence: found(this.stringify(lead.evidence)), sourceUrls: found(this.stringify(lead.sourceUrls)), duplicateStatus: found(this.record(lead.duplicate).status),
      createdAt: found(lead.createdAt), updatedAt: found(lead.updatedAt), lastVerifiedAt: found(lead.lastVerifiedAt ?? company.lastVerifiedAt),
    };
    return mapping[field] ?? (missing === 'EMPTY' ? '' : 'NOT_FOUND');
  }

  private qualificationReason(qualification: Record<string, unknown>): unknown {
    const parts: string[] = [];
    for (const key of ['qualifiedReasons', 'disqualifiedReasons', 'needsReviewReasons'] as const) {
      const value = qualification[key];
      if (Array.isArray(value) && value.length) parts.push(...value.map((item) => String(item)));
    }
    if (parts.length) return parts.join('; ');
    return null;
  }

  private present(value: unknown, missing: string): unknown {
    if (value === null || value === undefined || value === '') return missing;
    return value;
  }

  private companySocial(lead: Record<string, unknown>, platform: string, missing: MissingValueMode): unknown {
    const profiles = Array.isArray(lead.socialProfiles) ? lead.socialProfiles : [];
    const match = profiles.find((item) => {
      if (!item || typeof item !== 'object' || !('platform' in item)) return false;
      const name = String(item.platform).toLowerCase();
      return name === platform || (platform === 'x' && name === 'twitter');
    }) as { profileUrl?: unknown } | undefined;
    return this.present(match?.profileUrl, missing === 'EMPTY' ? '' : 'NOT_FOUND');
  }

  private record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}; }
  private stringify(value: unknown) { return value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value); }
}
