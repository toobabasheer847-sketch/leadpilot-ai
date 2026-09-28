import type { SearchPlan } from '../search/types/search-plan.types';

const COMPANY_ALWAYS = new Set(['companyName', 'website']);

const COMPANY_FIELD_ALIASES: Record<string, string[]> = {
  name: ['companyName'],
  companyname: ['companyName'],
  website: ['website'],
  location: ['city', 'state', 'country', 'zip'],
  city: ['city'],
  state: ['state'],
  country: ['country'],
  zip: ['zip'],
  postalcode: ['zip'],
  employeesize: ['companySize'],
  companysize: ['companySize'],
  employeerange: ['companySize'],
  category: ['category'],
  industry: ['category'],
  companyemail: ['email'],
  email: ['email'],
  companyphone: ['phone'],
  phone: ['phone'],
  description: ['description'],
  investortype: ['investorType'],
  investmentstrategy: ['investmentStrategy'],
  linkedin: ['linkedin'],
  facebook: ['facebook'],
  instagram: ['instagram'],
  youtube: ['youtube'],
  twitter: ['twitter'],
  x: ['twitter'],
  companysocials: ['linkedin', 'facebook', 'instagram', 'youtube', 'twitter'],
  socials: ['linkedin', 'facebook', 'instagram', 'youtube', 'twitter'],
};

const PERSON_FIELD_ALIASES: Record<string, string[]> = {
  fullname: ['fullName'],
  personname: ['fullName'],
  name: ['fullName'],
  title: ['title'],
  persontitle: ['title'],
  normalizedrole: ['normalizedRole'],
  role: ['normalizedRole'],
  professionalemail: ['email'],
  personemail: ['email'],
  email: ['email'],
  professionalphone: ['phone'],
  personphone: ['phone'],
  phone: ['phone'],
  companyrelationship: ['companyRelationship'],
  linkedin: ['linkedin'],
  facebook: ['facebook'],
  instagram: ['instagram'],
  youtube: ['youtube'],
  twitter: ['twitter'],
  x: ['twitter'],
  personsocials: ['linkedin', 'facebook', 'instagram', 'youtube', 'twitter'],
  socials: ['linkedin', 'facebook', 'instagram', 'youtube', 'twitter'],
};

const DEFAULT_COMPANY_FIELDS = [
  'companyName', 'website', 'description', 'phone', 'email', 'category',
  'investorType', 'investmentStrategy', 'companySize', 'city', 'state', 'zip', 'country',
];

const DEFAULT_PERSON_FIELDS = [
  'fullName', 'title', 'companyRelationship', 'email', 'phone',
  'linkedin', 'facebook', 'instagram', 'youtube', 'normalizedRole',
];

/** Resolve which company verification fields to evaluate for a SearchPlan. */
export function companyFieldsForVerification(plan: SearchPlan | null | undefined, availableSocials: string[] = []): string[] {
  if (!plan) return unique([...DEFAULT_COMPANY_FIELDS, ...availableSocials]);
  const requested = collectRequestedTokens(plan);
  if (!requested.size) return unique([...DEFAULT_COMPANY_FIELDS, ...availableSocials]);

  const fields = new Set<string>(COMPANY_ALWAYS);
  for (const token of requested) {
    for (const field of COMPANY_FIELD_ALIASES[token] ?? []) fields.add(field);
  }
  // Always verify identity + any socials already stored so conflicts surface.
  for (const platform of availableSocials) fields.add(platform);
  if (plan.emailRequirement?.requested) fields.add('email');
  if (plan.websiteRequirement?.requested) fields.add('website');
  if (plan.verificationRequirement?.fields?.length) {
    for (const raw of plan.verificationRequirement.fields) {
      for (const field of COMPANY_FIELD_ALIASES[normalizeToken(raw)] ?? []) fields.add(field);
    }
  }
  return [...fields];
}

/** Resolve which person verification fields to evaluate for a SearchPlan. */
export function personFieldsForVerification(plan: SearchPlan | null | undefined): string[] {
  if (!plan) return [...DEFAULT_PERSON_FIELDS];
  const requested = collectRequestedTokens(plan);
  const hasPersonIntent = Boolean(
    plan.decisionMakerRoles?.length
    || plan.requiredRoles?.length
    || plan.personFields?.length
    || plan.contactRequirements?.fields?.length
    || plan.emailRequirement?.requested
    || plan.targetType === 'QUALIFIED_LEADS',
  );
  if (!requested.size && !hasPersonIntent) return [...DEFAULT_PERSON_FIELDS];

  const fields = new Set<string>(['fullName', 'title', 'companyRelationship']);
  for (const token of requested) {
    for (const field of PERSON_FIELD_ALIASES[token] ?? []) fields.add(field);
  }
  for (const raw of plan.personFields ?? []) {
    for (const field of PERSON_FIELD_ALIASES[normalizeToken(raw)] ?? []) fields.add(field);
  }
  for (const raw of plan.contactRequirements?.fields ?? []) {
    for (const field of PERSON_FIELD_ALIASES[normalizeToken(raw)] ?? []) fields.add(field);
  }
  if (plan.emailRequirement?.requested) fields.add('email');
  for (const platform of plan.socialPlatforms ?? []) {
    for (const field of PERSON_FIELD_ALIASES[normalizeToken(platform)] ?? []) fields.add(field);
  }
  return [...fields];
}

export function fieldIsRequiredByPlan(plan: SearchPlan | null | undefined, field: string): boolean {
  if (!plan) return false;
  const required = new Set([
    ...(plan.requiredFields ?? []),
    ...(plan.verificationRequirement?.required ? (plan.verificationRequirement.fields ?? []) : []),
  ].map(normalizeToken));
  if (plan.emailRequirement?.required && field === 'email') return true;
  if (plan.websiteRequirement?.required && field === 'website') return true;
  const aliases = Object.entries({ ...COMPANY_FIELD_ALIASES, ...PERSON_FIELD_ALIASES })
    .filter(([, fields]) => fields.includes(field))
    .map(([token]) => token);
  return aliases.some((token) => required.has(token)) || required.has(normalizeToken(field));
}

function collectRequestedTokens(plan: SearchPlan): Set<string> {
  const bags = [
    plan.requiredFields,
    plan.preferredFields,
    plan.optionalFields,
    plan.companyFields,
    plan.personFields,
    plan.contactRequirements?.fields,
    plan.verificationRequirement?.fields,
    plan.socialPlatforms,
  ];
  const tokens = new Set<string>();
  for (const bag of bags) {
    for (const field of bag ?? []) tokens.add(normalizeToken(field));
  }
  return tokens;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
