import type { SearchPlan } from '../../search/types/search-plan.types';
import { contactDiscoveryRequested, employeeSizeRequested } from '../../search/search-plan.limits';
import type {
  CompanyCompletenessAssessment,
  CompletenessCompanyField,
  CompletenessFieldKey,
  CompletenessFieldState,
  CompletenessFieldStatus,
} from './completeness.types';

export type CompletenessSnapshot = {
  companyId: string;
  organizationId: string;
  name: string | null;
  category: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  description?: string | null;
  employeeCount: number | null;
  employeeRange: string | null;
  verificationStatus?: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  socialPlatforms: string[];
  contacts: Array<{
    fullName: string | null;
    title: string | null;
    email: string | null;
    linkedinUrl: string | null;
    facebookUrl: string | null;
    instagramUrl: string | null;
    twitterUrl: string | null;
    verificationStatus?: string | null;
  }>;
  hasSizeEvidence: boolean;
};

/** Pure assessment — never invents values; FOUND ≠ VERIFIED. */
export function assessCompanyCompleteness(snapshot: CompletenessSnapshot, plan: unknown): CompanyCompletenessAssessment {
  const record = plan && typeof plan === 'object' ? plan as Partial<SearchPlan> : {};
  const requestedCompany = requestedCompanyFields(record);
  const wantsContacts = contactDiscoveryRequested(plan);
  const wantsSize = employeeSizeRequested(plan);
  const wantsPersonEmail = Boolean(record.emailRequirement?.requested || fieldBagHas(record, /person.?email|^email$/i) && wantsContacts);
  const socialWanted = socialPlatformsWanted(record);

  const fields: CompletenessFieldStatus[] = [];
  const push = (field: CompletenessFieldKey, state: CompletenessFieldState, requested: boolean, sourceUrl?: string | null) => {
    fields.push({ field, state, requested, ...(sourceUrl ? { sourceUrl } : {}) });
  };

  push('companyName', snapshot.name ? presentState(snapshot.verificationStatus) : 'NOT_FOUND', true);
  push('category', snapshot.category ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('category'));
  push('city', snapshot.city ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('city') || requestedCompany.has('location'));
  push('state', snapshot.state ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('state') || requestedCompany.has('location'));
  push('country', snapshot.country ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('country') || requestedCompany.has('location'));
  push('address', snapshot.address ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('address'));
  push('phone', snapshot.phone ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('phone'));
  push('website', snapshot.website ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('website') || Boolean(record.websiteRequirement?.requested));
  push('companyEmail', snapshot.email ? 'FOUND' : 'NOT_FOUND', requestedCompany.has('email') || Boolean(record.emailRequirement?.requested && !wantsContacts));

  for (const platform of ['linkedin', 'facebook', 'instagram', 'twitter', 'youtube'] as const) {
    const field = companySocialField(platform);
    const has = snapshot.socialPlatforms.includes(platform);
    push(field, has ? 'FOUND' : 'NOT_FOUND', socialWanted.has(platform) || requestedCompany.has(platform) || requestedCompany.has(`company${platform}`));
  }

  const primary = snapshot.contacts[0] ?? null;
  const nameParts = splitName(primary?.fullName ?? null);
  push('firstName', nameParts.first ? 'FOUND' : 'NOT_FOUND', wantsContacts);
  push('lastName', nameParts.last ? 'FOUND' : 'NOT_FOUND', wantsContacts);
  push('title', primary?.title ? 'FOUND' : 'NOT_FOUND', wantsContacts);
  push('companyRelationship', primary?.fullName ? 'FOUND' : 'NOT_FOUND', wantsContacts);
  push('personLinkedin', primary?.linkedinUrl ? 'FOUND' : 'NOT_FOUND', wantsContacts && (socialWanted.has('linkedin') || personSocialRequested(record, 'linkedin')));
  push('personFacebook', primary?.facebookUrl ? 'FOUND' : 'NOT_FOUND', wantsContacts && (socialWanted.has('facebook') || personSocialRequested(record, 'facebook')));
  push('personInstagram', primary?.instagramUrl ? 'FOUND' : 'NOT_FOUND', wantsContacts && (socialWanted.has('instagram') || personSocialRequested(record, 'instagram')));
  push('personTwitter', primary?.twitterUrl ? 'FOUND' : 'NOT_FOUND', wantsContacts && (socialWanted.has('twitter') || socialWanted.has('x') || personSocialRequested(record, 'twitter')));
  push('personEmail', primary?.email ? personEmailState(primary) : 'NOT_FOUND', wantsPersonEmail || wantsContacts && Boolean(record.emailRequirement?.requested));

  push('employeeCount', snapshot.employeeCount != null ? 'FOUND' : 'NOT_FOUND', wantsSize);
  push('employeeRange', snapshot.employeeRange ? 'FOUND' : 'NOT_FOUND', wantsSize);
  push('sizeEvidence', snapshot.hasSizeEvidence ? 'FOUND' : 'NOT_FOUND', wantsSize);

  const missingRequested = fields.filter((item) => item.requested && (item.state === 'NOT_FOUND' || item.state === 'UNKNOWN')).map((item) => item.field);

  return {
    companyId: snapshot.companyId,
    organizationId: snapshot.organizationId,
    fields,
    missingRequested,
    needsWebsite: missingRequested.includes('website'),
    needsCompanyContacts: missingRequested.some((field) => field === 'phone' || field === 'companyEmail' || field === 'address'),
    needsCompanySocial: missingRequested.some((field) => String(field).startsWith('company') && /Linkedin|Facebook|Instagram|Twitter|Youtube/.test(String(field))),
    needsDecisionMaker: missingRequested.some((field) => field === 'firstName' || field === 'lastName' || field === 'title' || field === 'companyRelationship'),
    needsPersonSocial: missingRequested.some((field) => String(field).startsWith('person') && field !== 'personEmail'),
    needsPersonEmail: missingRequested.includes('personEmail'),
    needsEmployeeSize: missingRequested.some((field) => field === 'employeeCount' || field === 'employeeRange' || field === 'sizeEvidence'),
  };
}

function presentState(verificationStatus?: string | null): CompletenessFieldState {
  if (verificationStatus === 'VERIFIED') return 'VERIFIED';
  if (verificationStatus === 'NEEDS_REVIEW' || verificationStatus === 'CONFLICT') return 'NEEDS_REVIEW';
  if (verificationStatus === 'PARTIALLY_VERIFIED' || verificationStatus === 'SUPPORTED') return 'UNVERIFIED';
  return 'FOUND';
}

function personEmailState(contact: { email: string | null; verificationStatus?: string | null }): CompletenessFieldState {
  if (!contact.email) return 'NOT_FOUND';
  if (contact.verificationStatus === 'VERIFIED') return 'VERIFIED';
  if (contact.verificationStatus === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
  return 'UNVERIFIED';
}

function companySocialField(platform: 'linkedin' | 'facebook' | 'instagram' | 'twitter' | 'youtube'): CompletenessCompanyField {
  if (platform === 'linkedin') return 'companyLinkedin';
  if (platform === 'facebook') return 'companyFacebook';
  if (platform === 'instagram') return 'companyInstagram';
  if (platform === 'twitter') return 'companyTwitter';
  return 'companyYoutube';
}

function requestedCompanyFields(plan: Partial<SearchPlan>): Set<string> {
  const keys = new Set<string>();
  const bags = [plan.companyFields, plan.requiredFields, plan.preferredFields, plan.optionalFields];
  for (const bag of bags) {
    for (const field of bag ?? []) {
      const normalized = field.toLowerCase().replace(/[^a-z0-9]+/g, '');
      keys.add(normalized);
      if (/website/.test(normalized)) keys.add('website');
      if (/phone/.test(normalized)) keys.add('phone');
      if (/email/.test(normalized) && !/person/.test(normalized)) keys.add('email');
      if (/address/.test(normalized)) keys.add('address');
      if (/city/.test(normalized)) keys.add('city');
      if (/state/.test(normalized)) keys.add('state');
      if (/country/.test(normalized)) keys.add('country');
      if (/location/.test(normalized)) keys.add('location');
      if (/categor|industr/.test(normalized)) keys.add('category');
      if (/linkedin/.test(normalized)) keys.add('linkedin');
      if (/facebook/.test(normalized)) keys.add('facebook');
      if (/instagram/.test(normalized)) keys.add('instagram');
      if (/twitter|^x$/.test(normalized)) keys.add('twitter');
      if (/youtube/.test(normalized)) keys.add('youtube');
    }
  }
  if (plan.websiteRequirement?.requested) keys.add('website');
  for (const platform of plan.socialPlatforms ?? []) {
    keys.add(platform.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  }
  return keys;
}

function socialPlatformsWanted(plan: Partial<SearchPlan>): Set<string> {
  const set = new Set<string>();
  for (const platform of plan.socialPlatforms ?? []) {
    const value = platform.toLowerCase();
    if (value.includes('linkedin')) set.add('linkedin');
    if (value.includes('facebook')) set.add('facebook');
    if (value.includes('instagram')) set.add('instagram');
    if (value.includes('youtube')) set.add('youtube');
    if (value === 'x' || value.includes('twitter')) set.add('twitter');
  }
  return set;
}

function personSocialRequested(plan: Partial<SearchPlan>, platform: string): boolean {
  return fieldBagHas(plan, new RegExp(`person.?${platform}|${platform}`, 'i')) && !fieldBagHas(plan, new RegExp(`company.?${platform}`, 'i'));
}

function fieldBagHas(plan: Partial<SearchPlan>, pattern: RegExp): boolean {
  const bags = [plan.personFields, plan.requiredFields, plan.preferredFields, plan.optionalFields, plan.contactRequirements?.fields];
  for (const bag of bags) {
    for (const field of bag ?? []) {
      if (pattern.test(field)) return true;
    }
  }
  return false;
}

function splitName(fullName: string | null): { first: string | null; last: string | null } {
  if (!fullName?.trim()) return { first: null, last: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] ?? null, last: null };
  return { first: parts[0] ?? null, last: parts.slice(1).join(' ') };
}

export function assessmentNeedsRetry(assessment: CompanyCompletenessAssessment): boolean {
  return assessment.missingRequested.length > 0 && (
    assessment.needsWebsite
    || assessment.needsCompanyContacts
    || assessment.needsCompanySocial
    || assessment.needsDecisionMaker
    || assessment.needsPersonSocial
    || assessment.needsPersonEmail
    || assessment.needsEmployeeSize
  );
}
