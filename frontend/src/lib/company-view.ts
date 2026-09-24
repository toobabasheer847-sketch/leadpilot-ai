import type { CompanyProfile, EvidenceItem, LeadRecord, VerificationField } from '../types/api';
import { evidenceCountFor } from './evidence';

export interface CompanyOverviewData {
  name: string | null;
  website: string | null;
  description: string | null;
  category: string | null;
  investorType: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  marketsServed: unknown;
  propertyTypes: unknown;
  investmentStrategy: string | null;
}

export function toCompanyOverview(lead: LeadRecord, profile: CompanyProfile | null): CompanyOverviewData {
  const location = lead.company.location;
  return {
    name: profile?.name ?? lead.company.name,
    website: profile?.website ?? lead.company.website,
    description: profile?.description ?? lead.company.description ?? null,
    category: profile?.category ?? lead.company.category ?? null,
    investorType: profile?.investorType ?? lead.company.investorType,
    address: location?.address ?? null,
    city: location?.city ?? null,
    state: location?.state ?? null,
    zipCode: location?.zipCode ?? null,
    country: location?.country ?? null,
    phone: profile?.phone ?? lead.company.phone ?? null,
    email: profile?.email ?? lead.company.email ?? null,
    marketsServed: profile?.marketsServed ?? lead.company.marketsServed ?? null,
    propertyTypes: profile?.propertyTypes ?? lead.company.propertyTypes ?? null,
    investmentStrategy: profile?.investmentStrategy ?? lead.company.investmentStrategy ?? null,
  };
}

const REQUESTED_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'companyName', label: 'Company Name' },
  { key: 'website', label: 'Website' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'fullName', label: 'Decision Maker Name' },
  { key: 'title', label: 'Decision Maker Title' },
  { key: 'linkedin', label: 'Social Profiles · linkedin' },
  { key: 'facebook', label: 'Social Profiles · facebook' },
  { key: 'instagram', label: 'Social Profiles · instagram' },
  { key: 'youtube', label: 'Social Profiles · youtube' },
];

export interface VerificationCardModel {
  key: string;
  label: string;
  value: string | null;
  status: string | null;
  evidenceCount: number | null;
  verifiedAt: string | null;
}

export function verificationCards(fields: VerificationField[], evidence: EvidenceItem[]): VerificationCardModel[] {
  const cards: VerificationCardModel[] = [];
  for (const requested of REQUESTED_FIELDS) {
    const matches = fields.filter((field) => field.fieldName === requested.key);
    if (!matches.length) {
      cards.push({ key: requested.key, label: requested.label, value: null, status: 'NOT_FOUND', evidenceCount: null, verifiedAt: null });
      continue;
    }
    matches.forEach((field, index) => {
      cards.push({
        key: `${requested.key}-${field.contactId ?? 'company'}-${index}`,
        label: requested.label,
        value: field.fieldValue,
        status: field.status,
        evidenceCount: evidenceCountFor(requested.key, field.metadata, evidence),
        verifiedAt: field.checkedAt,
      });
    });
  }
  return cards;
}
