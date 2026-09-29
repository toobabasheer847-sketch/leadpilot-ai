import type { SearchPlan } from '../search/types/search-plan.types';
import { DEFAULT_EXPORT_FIELDS, EXPORT_FIELDS, type ExportField } from './types/export.types';

/** Human-readable column titles for CSV/XLSX headers. */
export const EXPORT_FIELD_HEADERS: Record<ExportField, string> = {
  companyName: 'Company Name',
  website: 'Official Website',
  domain: 'Domain',
  companyPhone: 'Company Phone',
  companyEmail: 'Company Email',
  address: 'Address',
  city: 'City',
  state: 'State',
  zipCode: 'Zip Code',
  country: 'Country',
  employeeCount: 'Employee Count',
  employeeRange: 'Employee Range',
  companySizeStatus: 'Company Size Status',
  contactName: 'Decision Maker Name',
  contactTitle: 'Title',
  contactEmail: 'Contact Email',
  contactPhone: 'Direct Phone',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  decisionMakerLinkedin: 'Decision Maker LinkedIn',
  decisionMakerFacebook: 'Decision Maker Facebook',
  decisionMakerInstagram: 'Decision Maker Instagram',
  decisionMakerYoutube: 'Decision Maker YouTube',
  decisionMakerX: 'Decision Maker X',
  companyLinkedin: 'Company LinkedIn',
  companyFacebook: 'Company Facebook',
  companyInstagram: 'Company Instagram',
  companyYoutube: 'Company YouTube',
  companyX: 'Company X',
  investorType: 'Investor Type',
  investmentStrategy: 'Investment Strategy',
  propertyType: 'Property Type',
  marketsServed: 'Markets Served',
  companySize: 'Company Size',
  classification: 'Classification',
  classificationConfidence: 'Classification Confidence',
  score: 'Lead Score',
  scoreBand: 'Score Band',
  qualificationStatus: 'Qualification Status',
  qualificationReason: 'Qualification Reason',
  verificationStatus: 'Verification Status',
  evidence: 'Evidence',
  sourceUrls: 'Source URLs',
  duplicateStatus: 'Duplicate Status',
  createdAt: 'Created At',
  updatedAt: 'Updated At',
  lastVerifiedAt: 'Last Verified At',
};

const PLAN_FIELD_TO_EXPORT: Record<string, ExportField[]> = {
  companyWebsite: ['website', 'domain'],
  website: ['website', 'domain'],
  companyEmail: ['companyEmail'],
  email: ['companyEmail'],
  companyPhone: ['companyPhone'],
  phone: ['companyPhone'],
  employeeCount: ['employeeCount', 'employeeRange', 'companySizeStatus'],
  location: ['address', 'city', 'state', 'zipCode', 'country'],
  industry: ['classification'],
  personName: ['contactName'],
  name: ['contactName'],
  personTitle: ['contactTitle'],
  title: ['contactTitle'],
  personEmail: ['contactEmail'],
  personPhone: ['contactPhone'],
  linkedin: ['decisionMakerLinkedin', 'linkedin'],
  facebook: ['decisionMakerFacebook', 'facebook'],
  instagram: ['decisionMakerInstagram', 'instagram'],
  youtube: ['decisionMakerYoutube'],
  x: ['decisionMakerX'],
};

const ALWAYS_INCLUDE: ExportField[] = [
  'companyName',
  'qualificationStatus',
  'qualificationReason',
  'score',
  'verificationStatus',
];

/**
 * Build export columns from a SearchPlan. Explicit `fields` override wins upstream;
 * this is used when the client does not specify columns.
 */
export function columnsFromSearchPlan(plan: SearchPlan | null | undefined): ExportField[] {
  if (!plan) return [...DEFAULT_EXPORT_FIELDS];

  const requested = new Set<string>();
  for (const bag of [
    plan.companyFields,
    plan.personFields,
    plan.requiredFields,
    plan.optionalFields,
    plan.preferredFields,
    plan.contactRequirements?.fields,
    plan.socialPlatforms,
    plan.verificationRequirement?.fields,
  ]) {
    for (const field of bag ?? []) {
      if (typeof field === 'string' && field.trim()) requested.add(field.trim());
    }
  }

  const columns: ExportField[] = [];
  const push = (field: ExportField) => {
    if (!columns.includes(field) && (EXPORT_FIELDS as readonly string[]).includes(field)) columns.push(field);
  };

  for (const field of ALWAYS_INCLUDE) push(field);

  if (!requested.size) {
    for (const field of DEFAULT_EXPORT_FIELDS) push(field);
    return columns;
  }

  for (const planField of requested) {
    const mapped = PLAN_FIELD_TO_EXPORT[planField];
    if (mapped) {
      for (const field of mapped) push(field);
      continue;
    }
    if ((EXPORT_FIELDS as readonly string[]).includes(planField)) push(planField as ExportField);
  }

  if (plan.websiteRequirement?.requested) push('website');
  if (plan.emailRequirement?.requested) {
    push('companyEmail');
    if (plan.emailRequirement.verified) push('contactEmail');
  }
  if ((plan.decisionMakerRoles?.length ?? 0) > 0 || (plan.requiredRoles?.length ?? 0) > 0 || (plan.contactRequirements?.titles.length ?? 0) > 0) {
    push('contactName');
    push('contactTitle');
  }
  for (const platform of plan.socialPlatforms ?? []) {
    const mapped = PLAN_FIELD_TO_EXPORT[platform];
    if (mapped) for (const field of mapped) push(field);
    const companyKey = `company${platform.charAt(0).toUpperCase()}${platform.slice(1)}` as ExportField;
    if (platform === 'x') push('companyX');
    else if ((EXPORT_FIELDS as readonly string[]).includes(companyKey)) push(companyKey);
  }

  return columns.length ? columns : [...DEFAULT_EXPORT_FIELDS];
}

export function displayHeaders(fields: ExportField[]): string[] {
  return fields.map((field) => EXPORT_FIELD_HEADERS[field] ?? field);
}
