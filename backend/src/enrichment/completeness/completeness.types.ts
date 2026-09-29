/**
 * Phase O — field completeness matrix.
 * Completeness is NOT verification: FOUND can still be UNVERIFIED.
 */

export type CompletenessFieldState =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'UNKNOWN'
  | 'UNVERIFIED'
  | 'VERIFIED'
  | 'NEEDS_REVIEW';

export type CompletenessCompanyField =
  | 'companyName'
  | 'category'
  | 'city'
  | 'state'
  | 'country'
  | 'address'
  | 'phone'
  | 'website'
  | 'companyEmail'
  | 'companyLinkedin'
  | 'companyFacebook'
  | 'companyInstagram'
  | 'companyTwitter'
  | 'companyYoutube';

export type CompletenessPersonField =
  | 'firstName'
  | 'lastName'
  | 'title'
  | 'companyRelationship'
  | 'personLinkedin'
  | 'personFacebook'
  | 'personInstagram'
  | 'personTwitter'
  | 'personEmail';

export type CompletenessSizeField = 'employeeCount' | 'employeeRange' | 'sizeEvidence';

export type CompletenessFieldKey = CompletenessCompanyField | CompletenessPersonField | CompletenessSizeField;

export interface CompletenessFieldStatus {
  field: CompletenessFieldKey;
  state: CompletenessFieldState;
  requested: boolean;
  sourceUrl?: string | null;
}

export interface CompanyCompletenessAssessment {
  companyId: string;
  organizationId: string;
  fields: CompletenessFieldStatus[];
  missingRequested: CompletenessFieldKey[];
  needsWebsite: boolean;
  needsCompanyContacts: boolean;
  needsCompanySocial: boolean;
  needsDecisionMaker: boolean;
  needsPersonSocial: boolean;
  needsPersonEmail: boolean;
  needsEmployeeSize: boolean;
}

export interface CompletenessPassStats {
  companiesAssessed: number;
  companiesRetried: number;
  fieldsFilled: number;
  searchesSkipped: number;
  providerFailures: number;
  durationMs: number;
}

export const MAX_COMPLETENESS_RETRIES_PER_COMPANY = 1;
