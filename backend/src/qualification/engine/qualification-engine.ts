import { assessCategoryEvidence } from '../../search/category-evidence';
import { assessPlanExclusions } from '../../search/exclusion-evidence';
import type { SearchPlan } from '../../search/types/search-plan.types';
import { roleMatches } from '../../contacts/discovery/public-decision-maker';
import { sameCountry } from '../../sources/location/location-evidence';
import { isGenericBusinessEmail } from '../../verification/utils/generic-email';
import type { CriterionEvidence, CriterionResultCode, QualificationContext, QualificationCriteria, QualificationDecision } from '../types/qualification.types';

const REAL_ESTATE_POSITIVE = [
  /\bbe?uy(?:s|ing)?\s+(?:houses?|homes?|properties|real estate)\b/i,
  /\bpurchase[sd]?\s+(?:houses?|homes?|properties)\b/i,
  /\bacquir(?:e|es|ed|ing)\b/i,
  /\bacquisition\b/i,
  /\bcash\s+(?:home|house)\s+(?:buy|purchase)/i,
  /\bfix(?:\s|-)?and(?:\s|-)?flip\b/i,
  /\bbuy(?:\s|-)?and(?:\s|-)?hold\b/i,
  /\bbrrrr?\b/i,
  /\brental\s+(?:property\s+)?acquisitions?\b/i,
  /\b(?:commercial|land|multifamily|multi-family)\s+(?:property\s+)?acquisitions?\b/i,
  /\binvestment\s+portfolio\b/i,
  /\b(?:owned|property)\s+portfolio\b/i,
  /\bwe\s+buy\s+houses?\b/i,
];

const REAL_ESTATE_NEGATIVE = [
  /\bbrokerage(?:\s+only)?\b/i,
  /\brealtor\b|\breal\s+estate\s+agent\b|\bestate\s+agent\b/i,
  /\bproperty\s+management(?:\s+only)?\b/i,
  /\bmortgage\b|\blending(?:\s+only)?\b|\blender\b/i,
  /\btitle\s+(?:company|services?)\b/i,
  /\binsurance\b/i,
  /\binspection\s+(?:company|services?)\b/i,
  /\blaw\s+firm\b|\blegal\s+services?\b/i,
  /\bcontractor\b/i,
  /\bapartment\s+leasing\b/i,
  /\bwholesal(?:e|ing)\b/i,
  /\bmarketing\s+(?:agency|services?)\b|\bsoftware\s+(?:company|platform)\b/i,
];

export const QUALIFICATION_VERSION = 'qualification-v1';

function hasRoles(plan: SearchPlan | null | undefined): boolean {
  return Boolean(
    (plan?.requiredRoles?.length ?? 0)
    || (plan?.decisionMakerRoles?.length ?? 0)
    || (plan?.contactRequirements?.titles?.length ?? 0),
  );
}

function tokenEquals(value: string, expected: string): boolean {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '') === expected.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bagHas(bag: string[] | undefined, ...names: string[]): boolean {
  return (bag ?? []).some((field) => names.some((name) => tokenEquals(field, name)));
}

/** Person/decision-maker email is required when the plan asked for a person mailbox (not a company inbox). */
export function planWantsPersonEmail(plan: SearchPlan | null | undefined): boolean {
  if (!plan) return false;
  if (bagHas(plan.personFields, 'email', 'personEmail')) return true;
  if (bagHas(plan.contactRequirements?.fields, 'email', 'personEmail')) return true;
  if (bagHas(plan.requiredFields, 'personEmail')) return true;
  if (bagHas(plan.optionalFields, 'personEmail')) return true;
  if (plan.emailRequirement?.requested && hasRoles(plan)) return true;
  return false;
}

export function planWantsCompanyEmail(plan: SearchPlan | null | undefined): boolean {
  if (!plan) return false;
  if (bagHas(plan.companyFields, 'email', 'companyEmail')) return true;
  if (bagHas(plan.requiredFields, 'companyEmail')) return true;
  if (bagHas(plan.optionalFields, 'companyEmail')) return true;
  // Plain email with no person/decision-maker context is company-level.
  if (plan.emailRequirement?.requested && !planWantsPersonEmail(plan)) return true;
  return false;
}

export function normalizeCriteria(plan: SearchPlan | null | undefined): QualificationCriteria {
  const requiredRoles = plan?.requiredRoles?.length
    ? plan.requiredRoles
    : plan?.decisionMakerRoles?.length
      ? plan.decisionMakerRoles
      : plan?.contactRequirements?.titles ?? [];
  const personEmailRequired = Boolean(
    planWantsPersonEmail(plan) && (plan?.emailRequirement?.required || plan?.emailRequirement?.verified || bagHas(plan?.requiredFields, 'email', 'personEmail')),
  );
  const companyEmailRequired = Boolean(
    planWantsCompanyEmail(plan) && (plan?.emailRequirement?.required || plan?.emailRequirement?.verified || bagHas(plan?.requiredFields, 'email', 'companyEmail')),
  );
  const verifiedEmailRequired = Boolean(plan?.emailRequirement?.verified || bagHas(plan?.verificationRequirement?.fields, 'email', 'personEmail', 'companyEmail'));

  const explicitRequiredFields = [...(plan?.requiredFields ?? [])];
  // Wire websiteRequirement.required into qualification (do not invent when only requested).
  if (plan?.websiteRequirement?.required && !bagHas(explicitRequiredFields, 'website', 'companyWebsite')) {
    explicitRequiredFields.push('website');
  }
  // Wire emailRequirement into qualification required fields.
  if (personEmailRequired && !bagHas(explicitRequiredFields, 'personEmail')) explicitRequiredFields.push('personEmail');
  if (companyEmailRequired && !bagHas(explicitRequiredFields, 'companyEmail') && !personEmailRequired) explicitRequiredFields.push('companyEmail');
  if ((plan?.emailRequirement?.required || plan?.emailRequirement?.verified) && !personEmailRequired && !companyEmailRequired && !bagHas(explicitRequiredFields, 'email')) {
    explicitRequiredFields.push('email');
  }

  // Promote person socials when requiredFields already names personLinkedin / etc.
  for (const social of ['linkedin', 'facebook', 'instagram', 'youtube', 'x'] as const) {
    const personKey = `person${social[0].toUpperCase()}${social.slice(1)}`;
    if (bagHas(explicitRequiredFields, personKey)) continue;
    if (bagHas(plan?.personFields, social, personKey) && bagHas(explicitRequiredFields, social)
      && !bagHas(explicitRequiredFields, `company${social[0].toUpperCase()}${social.slice(1)}`)) {
      explicitRequiredFields.push(personKey);
    }
  }

  const numericSize = hasNumericCompanySize(plan?.companySize) || hasNumericCompanySize(plan?.employeeSize) || hasNumericCompanySize(plan?.employeeRange);

  // Plain "email" with person intent must not be satisfied by a company mailbox.
  const requiredFields = [...new Set([
    ...explicitRequiredFields.filter((field) => !(personEmailRequired && tokenEquals(field, 'email'))),
    'companyName',
    ...(plan?.locations?.length ? ['location'] as const : []),
    ...(numericSize ? ['companySize'] as const : []),
    ...(requiredRoles.length ? ['decisionMaker'] as const : []),
    ...((plan?.industry?.length || plan?.leadTypes?.length) ? ['category'] as const : []),
  ])];

  const socialPlatforms = [...new Set((plan?.socialPlatforms ?? []).map((item) => item.toLowerCase() === 'twitter' ? 'x' : item.toLowerCase()))];
  // Ensure required company social platforms appear in socialPlatforms for evaluation.
  for (const field of explicitRequiredFields) {
    const match = field.match(/^company(linkedin|facebook|instagram|youtube|x|twitter)$/i);
    if (!match) continue;
    const platform = match[1].toLowerCase() === 'twitter' ? 'x' : match[1].toLowerCase();
    if (!socialPlatforms.includes(platform)) socialPlatforms.push(platform);
  }

  const optionalFromPlan = [
    ...(plan?.optionalFields ?? plan?.companyFields ?? []),
    ...(plan?.contactRequirements?.fields ?? []),
    // Soft/generic socials stay optional unless requiredFields/company* marks them required.
    ...socialPlatforms.filter((platform) => !bagHas(requiredFields, platform, `company${platform[0].toUpperCase()}${platform.slice(1)}`)),
    ...(planWantsPersonEmail(plan) && plan?.emailRequirement?.requested && !personEmailRequired ? ['personEmail'] : []),
    ...(planWantsCompanyEmail(plan) && plan?.emailRequirement?.requested && !companyEmailRequired ? ['companyEmail'] : []),
  ];
  const optionalFields = [...new Set(optionalFromPlan.filter((field) => !requiredFields.includes(field) && !bagHas(requiredFields, field) && field !== 'name'))];

  const companyRequiredFields = explicitRequiredFields.filter((field) => [
    'companyWebsite', 'companyEmail', 'companyPhone', 'companyEmployeeCount', 'companyLocation',
    'companyLinkedin', 'companyFacebook', 'companyInstagram', 'companyYoutube', 'companyX',
  ].includes(field));
  if (companyEmailRequired && !companyRequiredFields.includes('companyEmail')) companyRequiredFields.push('companyEmail');
  if (plan?.websiteRequirement?.required && !companyRequiredFields.includes('companyWebsite') && !bagHas(requiredFields, 'website')) {
    companyRequiredFields.push('companyWebsite');
  }

  const personRequiredFields = explicitRequiredFields.filter((field) => [
    'personName', 'personTitle', 'personEmail', 'personPhone',
    'personLinkedin', 'personFacebook', 'personInstagram', 'personYoutube', 'personX',
  ].includes(field));
  if (personEmailRequired && !personRequiredFields.includes('personEmail')) personRequiredFields.push('personEmail');

  const verificationRequiredFields = [...new Set([
    ...(plan?.verificationRequirement?.fields ?? []),
    ...(verifiedEmailRequired ? (personEmailRequired ? ['email', 'personEmail'] : companyEmailRequired ? ['email', 'companyEmail'] : ['email']) : []),
  ])];

  return {
    industry: plan?.industry ?? [],
    leadTypes: plan?.leadTypes ?? [],
    locations: plan?.locations ?? [],
    companySize: numericSize ? (plan?.companySize ?? plan?.employeeSize ?? plan?.employeeRange) : undefined,
    requiredRoles,
    requiredFields,
    optionalFields,
    companyRequiredFields,
    personRequiredFields,
    preferredFields: plan?.preferredFields ?? [],
    verificationRequiredFields,
    socialPlatforms,
    personEmailRequired,
    companyEmailRequired,
    verifiedEmailRequired,
    exclusions: [...(plan?.exclusions ?? [])].map((item) => item.trim()).filter(Boolean),
    requestedCount: plan?.requestedCount ?? plan?.maxResults,
    countIntent: plan?.countIntent,
    minimumScore: plan?.minimumScore,
  };
}

function hasNumericCompanySize(size?: { min?: number; max?: number; exact?: number } | null): boolean {
  return Boolean(size && (typeof size.min === 'number' || typeof size.max === 'number' || typeof size.exact === 'number'));
}

export function evaluateQualification(context: QualificationContext, criteria: QualificationCriteria): QualificationDecision {
  const results: CriterionEvidence[] = [];

  results.push(evaluateIdentity(context));
  const websiteRequired = criteria.requiredFields.includes('website')
    || criteria.companyRequiredFields.includes('companyWebsite');
  if (websiteRequired || criteria.optionalFields.includes('website') || criteria.preferredFields.includes('companyWebsite') || criteria.preferredFields.includes('website')) {
    results.push(evaluateWebsite(context, websiteRequired));
  }
  if (criteria.locations.length) results.push(evaluateLocation(context, criteria));
  if (criteria.companySize) results.push(evaluateCompanySize(context, criteria));
  if (criteria.industry.length || criteria.leadTypes.length) results.push(evaluateCategory(context, criteria));
  if (criteria.requiredRoles.length) results.push(evaluateDecisionMaker(context, criteria));
  if (criteria.exclusions.length) results.push(evaluateExclusions(context, criteria));

  for (const field of new Set([...criteria.companyRequiredFields, ...criteria.personRequiredFields, ...criteria.preferredFields])) {
    if (['companyWebsite', 'website', 'companyLinkedin', 'companyFacebook', 'companyInstagram', 'companyYoutube', 'companyX'].includes(field)) continue;
    const key = field.replace(/^(company|person)/, '').toLowerCase();
    const verificationRequired = criteria.verificationRequiredFields.some((item) => item.toLowerCase() === key || item.toLowerCase() === field.toLowerCase())
      || (criteria.verifiedEmailRequired && /email/i.test(key));
    results.push(evaluateSpecificField(context, field, criteria.companyRequiredFields.includes(field) || criteria.personRequiredFields.includes(field), verificationRequired, criteria.requiredRoles));
  }

  for (const field of ['email', 'phone', 'linkedin', 'facebook', 'instagram', 'youtube'] as const) {
    // personEmail/companyEmail and personLinkedin* are evaluated above; plain email must not use company fallback for person intent.
    if (field === 'email' && (criteria.personEmailRequired || criteria.companyEmailRequired)) continue;
    if (field !== 'email' && criteria.personRequiredFields.some((item) => tokenEquals(item, `person${field}`))) continue;
    if (criteria.requiredFields.includes(field) || criteria.optionalFields.includes(field)) {
      const personOnly = criteria.personEmailRequired || criteria.requiredRoles.length > 0 || field !== 'email';
      results.push(evaluateContactField(context, field, criteria.requiredFields.includes(field), {
        personOnlyEmail: field === 'email' ? (criteria.personEmailRequired || criteria.requiredRoles.length > 0) : personOnly,
        verificationRequired: (criteria.verifiedEmailRequired && field === 'email')
          || criteria.verificationRequiredFields.some((item) => tokenEquals(item, field)),
        requiredRoles: criteria.requiredRoles,
      }));
    }
  }

  for (const platform of criteria.socialPlatforms) {
    const required = criteria.requiredFields.some((field) => tokenEquals(field, platform) || tokenEquals(field, `company${platform}`))
      || criteria.companyRequiredFields.some((field) => tokenEquals(field, `company${platform}`));
    results.push(evaluateCompanySocial(context, platform, required));
  }

  for (const field of criteria.verificationRequiredFields) {
    if (/email|personemail|companyemail/i.test(field)) continue;
    if (results.some((item) => tokenEquals(item.criterion, field) || tokenEquals(item.criterion, `person${field}`) || tokenEquals(item.criterion, `company${field}`))) continue;
    results.push(evaluateVerificationRequirement(context, field, true));
  }

  const conflictResult = evaluateConflicts(context, criteria);
  if (conflictResult) results.push(conflictResult);

  const required = results.filter((item) => item.required);
  const hasNoMatch = required.some((item) => item.result === 'NO_MATCH');
  const hasReview = required.some((item) => item.result === 'NEEDS_REVIEW' || item.result === 'NOT_FOUND')
    || results.some((item) => item.criterion === 'conflicts' && item.result === 'NEEDS_REVIEW');

  let status: QualificationDecision['status'] = 'QUALIFIED';
  if (hasNoMatch) status = 'NOT_QUALIFIED';
  else if (hasReview) status = 'NEEDS_REVIEW';

  // Score never overrides required criteria failures — applied only after factual gates pass.
  if (status === 'QUALIFIED' && criteria.minimumScore !== undefined) {
    const score = context.score?.value ?? null;
    if (score === null) {
      results.push({
        criterion: 'minimumScore',
        result: 'NOT_FOUND',
        source: 'lead_scores',
        sourceUrl: null,
        evidenceExcerpt: null,
        retrievedAt: null,
        verificationStatus: null,
        required: true,
        message: `Minimum score ${criteria.minimumScore} was requested but no score is available.`,
      });
      status = 'NEEDS_REVIEW';
    } else if (score < criteria.minimumScore) {
      results.push({
        criterion: 'minimumScore',
        result: 'NO_MATCH',
        source: 'lead_scores',
        sourceUrl: null,
        evidenceExcerpt: `score=${score}`,
        retrievedAt: null,
        verificationStatus: null,
        required: true,
        message: `Score ${score} is below required minimum ${criteria.minimumScore}.`,
      });
      status = 'NOT_QUALIFIED';
    } else {
      results.push({
        criterion: 'minimumScore',
        result: 'MATCH',
        source: 'lead_scores',
        sourceUrl: null,
        evidenceExcerpt: `score=${score}`,
        retrievedAt: null,
        verificationStatus: null,
        required: true,
        message: `Score ${score} meets minimum ${criteria.minimumScore}.`,
      });
    }
  }

  const qualifiedReasons = results.filter((item) => item.result === 'MATCH').map((item) => item.message);
  const disqualifiedReasons = results.filter((item) => item.required && item.result === 'NO_MATCH').map((item) => item.message);
  const needsReviewReasons = results.filter((item) => item.result === 'NEEDS_REVIEW' || (item.required && item.result === 'NOT_FOUND')).map((item) => item.message);
  const missingOptional = results.filter((item) => !item.required && (item.result === 'NOT_FOUND' || item.result === 'NO_MATCH')).map((item) => `${item.criterion}: ${item.message}`);

  return {
    status,
    criteria,
    criterionResults: results,
    qualifiedReasons,
    disqualifiedReasons,
    needsReviewReasons,
    missingOptional,
    score: context.score?.value ?? null,
    scoreBand: context.score?.band ?? null,
    scoreBreakdown: context.score?.breakdown ?? null,
  };
}

function evaluateSpecificField(context: QualificationContext, field: string, required: boolean, verificationRequired: boolean, requiredRoles: string[] = []): CriterionEvidence {
  const person = field.startsWith('person');
  const key = field.replace(/^(company|person)/, '').toLowerCase();
  const contact = preferredContact(context, requiredRoles);
  const value = person
    ? key === 'name' ? contact?.fullName ?? null
      : key === 'title' ? contact?.title ?? null
        : key === 'email' ? contact?.email ?? null
          : key === 'phone' ? contact?.phone ?? null
            : key === 'linkedin' ? contact?.linkedinUrl ?? null
              : key === 'facebook' ? contact?.facebookUrl ?? null
                : key === 'instagram' ? contact?.instagramUrl ?? null
                  : key === 'youtube' ? contact?.youtubeUrl ?? null
                    : null
    : key === 'website' ? context.company.website
      : key === 'email' ? context.company.email
        : key === 'phone' ? context.company.phone
          : key === 'employeecount' ? context.company.employeeCount?.toString() ?? context.company.employeeRange
            : key === 'location' ? [context.location?.city, context.location?.state, context.location?.country].filter(Boolean).join(', ') || null
              : null;
  const verificationField = key === 'employeecount' ? 'companySize' : key === 'name' ? 'fullName' : key;
  const verification = fieldStatus(context, verificationField);
  if (!value) return evidence(field, 'NOT_FOUND', required, `${field} was not found.`, null, verification);
  if (person && key === 'email' && isGenericBusinessEmail(value)) {
    return evidence(field, 'NOT_FOUND', required, 'Generic/company mailbox cannot satisfy a person email requirement.', {
      source: 'contact_record',
      sourceUrl: null,
      excerpt: value,
    }, verification ?? 'UNVERIFIED');
  }
  if (verification === 'INVALID') {
    return evidence(field, 'NO_MATCH', required, `${field} failed verification.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
  }
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence(field, 'NEEDS_REVIEW', required, `${field} has conflicting verification evidence.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
  }
  if (person && key === 'email' && verificationRequired) {
    if (!personEmailOwnershipVerified(context)) {
      return evidence(field, 'NEEDS_REVIEW', true, 'Person email lacks person-ownership verification (syntax, single-source evidence, or deliverability alone is not enough).', {
        source: 'verification',
        sourceUrl: null,
        excerpt: value,
      }, verification ?? 'UNVERIFIED');
    }
  } else if (required && verificationRequired && /email|phone|linkedin|facebook|instagram|youtube|website/i.test(key)) {
    // Company/other fields: SUPPORTED or VERIFIED evidence still qualifies; never invent VERIFIED from absence.
    if (verification !== 'VERIFIED' && verification !== 'SUPPORTED') {
      return evidence(field, 'NEEDS_REVIEW', true, `${field} exists but is not verified/supported.`, { source: person ? 'contact_record' : 'company_record', sourceUrl: null, excerpt: value }, verification ?? 'UNVERIFIED');
    }
  }
  return evidence(field, 'MATCH', required, `${field} is available.`, { source: person ? 'contact_record' : 'company_record', sourceUrl: null, excerpt: value }, verification);
}

function evaluateCompanySocial(context: QualificationContext, platform: string, required: boolean): CriterionEvidence {
  const normalized = platform.toLowerCase();
  const aliases = normalized === 'x' ? ['x', 'twitter'] : [normalized];
  const profile = (context.socialProfiles ?? []).find((item) => aliases.includes(item.platform.toLowerCase()) && item.profileUrl);
  if (!profile?.profileUrl) {
    return evidence(`companySocial:${normalized}`, 'NOT_FOUND', required, `Company ${normalized} profile was not found.`, null, null);
  }
  return evidence(`companySocial:${normalized}`, 'MATCH', required, `Company ${normalized} profile is available.`, {
    source: 'company_social_profiles',
    sourceUrl: profile.profileUrl,
    excerpt: profile.profileUrl,
  }, fieldStatus(context, normalized));
}

function evaluateIdentity(context: QualificationContext): CriterionEvidence {
  const verification = fieldStatus(context, 'companyName');
  if (!context.company.name) {
    return evidence('companyName', 'NOT_FOUND', true, 'Company name is missing.', null, verification);
  }
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence('companyName', 'NEEDS_REVIEW', true, 'Company identity has unresolved verification conflict.', null, verification);
  }
  return evidence('companyName', verification === 'VERIFIED' || verification === 'SUPPORTED' ? 'MATCH' : 'MATCH', true, 'Company name is present.', {
    source: 'company_record',
    sourceUrl: context.company.website,
    excerpt: context.company.name,
  }, verification);
}

function evaluateWebsite(context: QualificationContext, required: boolean): CriterionEvidence {
  const verification = fieldStatus(context, 'website');
  const value = context.company.website;
  if (!value) return evidence('website', 'NOT_FOUND', required, 'Official website was not found.', null, verification);
  if (verification === 'INVALID') {
    return evidence('website', 'NO_MATCH', required, 'Website is invalid or is not an official company site (social/directory/news hosts are rejected).', {
      source: 'verification',
      sourceUrl: value,
      excerpt: value,
    }, verification);
  }
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence('website', 'NEEDS_REVIEW', required, 'Website has conflicting verification evidence.', { source: 'verification', sourceUrl: value, excerpt: value }, verification);
  }
  return evidence('website', 'MATCH', required, `Website is available${verification === 'VERIFIED' || verification === 'SUPPORTED' ? ` and ${verification.toLowerCase()}` : ''}.`, {
    source: 'company_record',
    sourceUrl: value,
    excerpt: value,
  }, verification);
}

function evaluateVerificationRequirement(context: QualificationContext, field: string, required: boolean): CriterionEvidence {
  const normalized = field.replace(/^(company|person)/i, '');
  const verification = fieldStatus(context, field) ?? fieldStatus(context, normalized);
  const contact = preferredContact(context, []);
  const value = (() => {
    const key = normalized.toLowerCase();
    if (key === 'website') return context.company.website;
    if (key === 'phone') return contact?.phone ?? context.company.phone;
    if (key === 'linkedin') return contact?.linkedinUrl;
    if (key === 'facebook') return contact?.facebookUrl;
    if (key === 'instagram') return contact?.instagramUrl;
    if (key === 'youtube') return contact?.youtubeUrl;
    return null;
  })();
  if (!value) return evidence(`verification:${field}`, 'NOT_FOUND', required, `${field} was requested for verification but was not found.`, null, verification);
  if (verification === 'INVALID') {
    return evidence(`verification:${field}`, 'NO_MATCH', required, `${field} failed verification.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
  }
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence(`verification:${field}`, 'NEEDS_REVIEW', required, `${field} has unresolved verification conflict.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
  }
  if (verification !== 'VERIFIED' && verification !== 'SUPPORTED') {
    return evidence(`verification:${field}`, 'NEEDS_REVIEW', required, `${field} exists but is not verified/supported.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification ?? 'UNVERIFIED');
  }
  return evidence(`verification:${field}`, 'MATCH', required, `${field} meets the verification requirement (${verification}).`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
}

function evaluateLocation(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence {
  const verification = fieldStatus(context, 'state') ?? fieldStatus(context, 'city') ?? fieldStatus(context, 'country');
  if (!context.location?.state && !context.location?.city && !context.location?.country) {
    return evidence('location', 'NOT_FOUND', true, 'Location evidence was not found.', null, verification);
  }
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence('location', 'NEEDS_REVIEW', true, 'Location has unresolved verification conflict.', {
      source: 'company_locations',
      sourceUrl: null,
      excerpt: [context.location.city, context.location.state, context.location.country].filter(Boolean).join(', '),
    }, verification);
  }
  const foundLabel = [context.location.city, context.location.state, context.location.country].filter(Boolean).join(', ') || 'unknown';
  const fits = criteria.locations.map((wanted) => placeFit(wanted, context.location));
  if (fits.includes('match')) {
    return evidence('location', 'MATCH', true, `Location matched requested criteria (${foundLabel}).`, {
      source: 'company_locations',
      sourceUrl: null,
      excerpt: foundLabel,
    }, verification);
  }
  if (fits.includes('incomplete')) {
    return evidence('location', 'NEEDS_REVIEW', true, `Location evidence is incomplete for the requested place (found ${foundLabel}).`, {
      source: 'company_locations',
      sourceUrl: null,
      excerpt: foundLabel,
    }, verification);
  }
  return evidence('location', 'NO_MATCH', true, `Location did not match requested criteria (found ${foundLabel}).`, {
    source: 'company_locations',
    sourceUrl: null,
    excerpt: foundLabel,
  }, verification);
}

function placeFit(
  wanted: { country?: string; state?: string; city?: string; region?: string },
  found: QualificationContext['location'],
): 'match' | 'conflict' | 'incomplete' {
  let matched = false;
  let missing = false;
  const agree = (ok: boolean | undefined, present: boolean) => {
    if (!present) missing = true;
    else if (ok) matched = true;
    else return true;
    return false;
  };
  let conflict = false;
  if (wanted.country) conflict = agree(found?.country ? sameCountry(wanted.country, found.country) : false, Boolean(found?.country)) || conflict;
  if (wanted.state) {
    const stateAgrees = Boolean(found?.state && normalizeState(wanted.state) === normalizeState(found.state))
      || Boolean(!found?.state && found?.city && normalizeState(found.city) === normalizeState(wanted.state));
    const statePresent = Boolean(found?.state) || stateAgrees;
    conflict = agree(stateAgrees, statePresent) || conflict;
  }
  if (wanted.city) conflict = agree(Boolean(found?.city && found.city.toLowerCase() === wanted.city.toLowerCase()), Boolean(found?.city)) || conflict;
  if (wanted.region) {
    const haystack = [found?.city, found?.state].filter(Boolean).join(' ').toLowerCase();
    conflict = agree(haystack.includes(wanted.region.toLowerCase()), Boolean(haystack)) || conflict;
  }
  if (conflict) return 'conflict';
  if (matched) return 'match';
  if (missing) return 'incomplete';
  return 'incomplete';
}

function evaluateCompanySize(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence {
  const verification = fieldStatus(context, 'companySize');
  const fit = companySizeFit(context.company.employeeCount, context.company.employeeRange, criteria.companySize);
  const excerpt = context.company.employeeCount != null ? String(context.company.employeeCount) : context.company.employeeRange;
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence('companySize', 'NEEDS_REVIEW', true, 'Company size evidence conflicts across sources.', {
      source: 'company_record',
      sourceUrl: null,
      excerpt,
    }, verification);
  }
  if (fit === 'UNKNOWN') {
    return evidence('companySize', 'NOT_FOUND', true, 'Company size could not be reliably established from evidence.', null, verification);
  }
  if (fit === 'OUTSIDE_RANGE') {
    return evidence('companySize', 'NO_MATCH', true, `Company size ${excerpt} is outside the requested range.`, {
      source: 'company_record',
      sourceUrl: null,
      excerpt,
    }, verification);
  }
  return evidence('companySize', 'MATCH', true, `Company size ${excerpt} matched the requested range.`, {
    source: 'company_record',
    sourceUrl: null,
    excerpt,
  }, verification);
}

export type CompanySizeFit = 'MATCHED' | 'UNKNOWN' | 'OUTSIDE_RANGE';

export function companySizeFit(employeeCount: number | null, employeeRange: string | null, bounds?: { min?: number; max?: number }): CompanySizeFit {
  const min = bounds?.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds?.max ?? Number.POSITIVE_INFINITY;
  if (typeof employeeCount === 'number' && Number.isFinite(employeeCount)) {
    return employeeCount >= min && employeeCount <= max ? 'MATCHED' : 'OUTSIDE_RANGE';
  }
  const span = parseEmployeeSpan(employeeRange);
  if (!span) return 'UNKNOWN';
  if (span.max < min || span.min > max) return 'OUTSIDE_RANGE';
  if (span.min >= min && span.max <= max) return 'MATCHED';
  return 'UNKNOWN';
}

function evaluateExclusions(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence {
  const corpus = [
    context.company.name,
    context.company.description,
    context.company.category,
    context.company.investorType,
    ...context.evidence.map((item) => item.evidenceText),
  ].filter(Boolean).join(' ');
  const assessments = assessPlanExclusions({
    exclusions: criteria.exclusions,
    text: corpus,
    companyName: context.company.name,
    category: context.company.category,
  });
  const excluded = assessments.filter((item) => item.verdict === 'EXCLUDED');
  if (excluded.length) {
    const lead = excluded[0];
    return evidence('exclusion', 'NO_MATCH', true, `Excluded by search plan (“${lead.exclusion}”).`, {
      source: 'exclusion_evidence',
      sourceUrl: null,
      excerpt: lead.excerpt,
    }, null);
  }
  const ambiguous = assessments.filter((item) => item.verdict === 'AMBIGUOUS');
  if (ambiguous.length) {
    const lead = ambiguous[0];
    return evidence('exclusion', 'NEEDS_REVIEW', true, `Exclusion evidence is ambiguous for “${lead.exclusion}”; not fabricating an exclusion decision.`, {
      source: 'exclusion_evidence',
      sourceUrl: null,
      excerpt: lead.excerpt,
    }, null);
  }
  return evidence('exclusion', 'MATCH', true, 'No exclusion match found in available evidence.', {
    source: 'exclusion_evidence',
    sourceUrl: null,
    excerpt: criteria.exclusions.join(', '),
  }, null);
}

function evaluateCategory(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence {
  const classification = context.classification;
  const relevantEvidence = context.evidence.filter((item) => item.evidenceText?.trim());
  const positiveHit = findEvidence(relevantEvidence, REAL_ESTATE_POSITIVE, { requirePositiveIntent: true });
  const negativeHit = findEvidence(relevantEvidence, REAL_ESTATE_NEGATIVE);
  const wantsInvestor = criteria.leadTypes.some((type) => /investor|buyer|flip|hold|brrr|commercial|land/i.test(type));
  const wantsIndustry = criteria.industry.length > 0;

  if (wantsInvestor) {
    if (positiveHit && negativeHit) {
      return evidence('category', 'NEEDS_REVIEW', true, 'Category evidence is ambiguous with both supporting and excluding signals.', {
        source: positiveHit.provider ?? 'stored-evidence',
        sourceUrl: positiveHit.sourceUrl,
        excerpt: positiveHit.evidenceText,
        evidenceId: positiveHit.id,
        retrievedAt: positiveHit.retrievedAt,
      }, null);
    }
    if (negativeHit && !positiveHit) {
      return evidence('category', 'NO_MATCH', true, 'Evidence indicates a non-investor service business without acquisition activity.', {
        source: negativeHit.provider ?? negativeHit.sourceType ?? 'stored-evidence',
        sourceUrl: negativeHit.sourceUrl,
        excerpt: negativeHit.evidenceText,
        evidenceId: negativeHit.id,
        retrievedAt: negativeHit.retrievedAt,
      }, null);
    }
    if (positiveHit && classification?.decision !== 'NOT_QUALIFIED') {
      return evidence(criteria.leadTypes[0] ?? 'category', 'MATCH', true, 'Official evidence supports the requested investor/acquisition activity.', {
        source: positiveHit.provider ?? positiveHit.sourceType ?? 'stored-evidence',
        sourceUrl: positiveHit.sourceUrl,
        excerpt: positiveHit.evidenceText,
        evidenceId: positiveHit.id,
        retrievedAt: positiveHit.retrievedAt,
      }, null);
    }
    if (classification?.decision === 'QUALIFIED' && Array.isArray(classification.positiveEvidence) && classification.positiveEvidence.length) {
      const first = classification.positiveEvidence[0] as { evidenceId?: string; reason?: string };
      const linked = relevantEvidence.find((item) => item.id === first.evidenceId) ?? positiveHit;
      if (linked) {
        return evidence(criteria.leadTypes[0] ?? 'category', 'MATCH', true, first.reason ?? 'Classification is QUALIFIED with cited evidence.', {
          source: linked.provider ?? linked.sourceType ?? 'classification',
          sourceUrl: linked.sourceUrl,
          excerpt: linked.evidenceText,
          evidenceId: linked.id,
          retrievedAt: linked.retrievedAt,
        }, null);
      }
    }
    if (classification?.decision === 'NOT_QUALIFIED') {
      return evidence('category', 'NO_MATCH', true, classification.exclusionReason ?? 'Classification found strong evidence the company does not match requested category.', {
        source: 'lead_classifications',
        sourceUrl: null,
        excerpt: classification.exclusionReason,
      }, null);
    }
    return evidence('category', 'NEEDS_REVIEW', true, 'Category evidence is insufficient to qualify or disqualify.', null, null);
  }

  if (wantsIndustry) {
    const assessment = assessCategoryEvidence({
      requested: criteria.industry,
      text: relevantEvidence.map((item) => item.evidenceText).join('\n'),
      companyName: context.company.name,
      taggedCategory: context.company.category,
    });
    const linked = relevantEvidence.find((item) => assessment.excerpt && item.evidenceText.toLowerCase().includes(assessment.excerpt.slice(0, 24))) ?? relevantEvidence[0];
    if (assessment.verdict === 'MATCH') {
      return evidence('category', 'MATCH', true, 'Industry/category evidence matched the requested search criteria.', {
        source: linked?.provider ?? linked?.sourceType ?? 'company_record',
        sourceUrl: linked?.sourceUrl ?? context.company.website,
        excerpt: assessment.excerpt ?? linked?.evidenceText ?? context.company.category,
        evidenceId: linked?.id,
        retrievedAt: linked?.retrievedAt ?? null,
      }, null);
    }
    if (assessment.verdict === 'NO_MATCH') {
      return evidence('category', 'NO_MATCH', true, 'Evidence does not support the requested business category.', {
        source: linked?.provider ?? linked?.sourceType ?? 'company_record',
        sourceUrl: linked?.sourceUrl ?? null,
        excerpt: assessment.excerpt ?? linked?.evidenceText ?? context.company.category,
        evidenceId: linked?.id ?? null,
        retrievedAt: linked?.retrievedAt ?? null,
      }, null);
    }
    return evidence('category', 'NEEDS_REVIEW', true, 'Category evidence is ambiguous or only repeats the company name.', {
      source: linked?.provider ?? 'company_record',
      sourceUrl: linked?.sourceUrl ?? null,
      excerpt: assessment.excerpt ?? context.company.name,
      evidenceId: linked?.id ?? null,
      retrievedAt: linked?.retrievedAt ?? null,
    }, null);
  }

  return evidence('category', 'MATCH', false, 'No category criteria were requested.', null, null);
}

function evaluateDecisionMaker(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence {
  const contacts = context.contacts.filter((contact) => contact.fullName);
  if (!contacts.length) {
    return evidence('decisionMaker', 'NOT_FOUND', true, 'No reliable decision-maker was found.', null, null);
  }
  const roleMatch = contacts.find((contact) => {
    const title = contact.title ?? '';
    const normalized = contact.normalizedRole ?? '';
    return criteria.requiredRoles.some((role) => roleMatches(title, [role]) || roleMatches(normalized, [role]));
  });
  if (!roleMatch) {
    return evidence('decisionMaker', 'NO_MATCH', true, `No decision-maker matched required roles (${criteria.requiredRoles.join(', ')}).`, {
      source: 'company_contacts',
      sourceUrl: null,
      excerpt: contacts.map((contact) => `${contact.fullName} (${contact.title ?? 'no title'})`).join('; '),
    }, null);
  }
  const verification = context.verifications.find((item) => ['fullName', 'title', 'companyRelationship'].includes(item.field) && (item.status === 'VERIFIED' || item.status === 'SUPPORTED' || item.status === 'CONFLICT' || item.status === 'NEEDS_REVIEW'));
  if (verification?.status === 'CONFLICT' || verification?.status === 'NEEDS_REVIEW' || roleMatch.verificationStatus === 'NEEDS_REVIEW' || roleMatch.verificationStatus === 'CONFLICT') {
    return evidence('decisionMaker', 'NEEDS_REVIEW', true, 'Decision-maker relationship or identity requires review due to conflicts.', {
      source: 'company_contacts',
      sourceUrl: roleMatch.linkedinUrl,
      excerpt: `${roleMatch.fullName} / ${roleMatch.title}`,
    }, verification?.status ?? roleMatch.verificationStatus);
  }
  if (!roleMatch.companyRelationship && verification?.status !== 'VERIFIED' && verification?.status !== 'SUPPORTED') {
    return evidence('decisionMaker', 'NEEDS_REVIEW', true, 'Decision-maker was found but company relationship is not strongly verified.', {
      source: 'company_contacts',
      sourceUrl: roleMatch.linkedinUrl,
      excerpt: `${roleMatch.fullName} / ${roleMatch.title}`,
    }, verification?.status ?? 'UNVERIFIED');
  }
  return evidence('decisionMaker', 'MATCH', true, `Decision-maker ${roleMatch.fullName} matched required role and relationship evidence.`, {
    source: 'company_contacts',
    sourceUrl: roleMatch.linkedinUrl,
    excerpt: `${roleMatch.fullName} / ${roleMatch.title}`,
  }, verification?.status ?? roleMatch.verificationStatus);
}

function evaluateContactField(
  context: QualificationContext,
  field: string,
  required: boolean,
  options: { personOnlyEmail?: boolean; verificationRequired?: boolean; requiredRoles?: string[] } = {},
): CriterionEvidence {
  const contact = preferredContact(context, options.requiredRoles ?? []);
  const value = field === 'email'
    ? (options.personOnlyEmail ? contact?.email ?? null : contact?.email ?? context.company.email)
    : field === 'phone' ? contact?.phone ?? context.company.phone
      : field === 'linkedin' ? contact?.linkedinUrl
        : field === 'facebook' ? contact?.facebookUrl
          : field === 'instagram' ? contact?.instagramUrl
            : contact?.youtubeUrl ?? null;
  const verification = fieldStatus(context, field);
  if (!value) return evidence(field, 'NOT_FOUND', required, `${field} was not found.`, null, verification);
  if (field === 'email' && options.personOnlyEmail && isGenericBusinessEmail(value)) {
    return evidence(field, 'NOT_FOUND', required, 'Generic/company mailbox cannot satisfy a person email requirement.', {
      source: 'contact_record',
      sourceUrl: null,
      excerpt: value,
    }, verification ?? 'UNVERIFIED');
  }
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence(field, 'NEEDS_REVIEW', required, `${field} has conflicting verification evidence.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
  }
  if (field === 'email' && options.personOnlyEmail && options.verificationRequired) {
    if (!personEmailOwnershipVerified(context)) {
      return evidence(field, 'NEEDS_REVIEW', required || Boolean(options.verificationRequired), 'Person email lacks person-ownership verification (syntax, single-source evidence, or deliverability alone is not enough).', {
        source: 'verification',
        sourceUrl: null,
        excerpt: value,
      }, verification ?? 'UNVERIFIED');
    }
  } else if ((required || options.verificationRequired) && (options.verificationRequired || required) && /email|phone/.test(field)) {
    if (verification !== 'VERIFIED' && verification !== 'SUPPORTED') {
      return evidence(field, 'NEEDS_REVIEW', required || Boolean(options.verificationRequired), `${field} exists but is not verified/supported.`, { source: 'contact_record', sourceUrl: null, excerpt: value }, verification ?? 'UNVERIFIED');
    }
  }
  return evidence(field, 'MATCH', required, `${field} is available.`, { source: 'contact_record', sourceUrl: null, excerpt: value }, verification);
}

/** Prefer a contact whose title matches requested roles; never invent people. */
function preferredContact(context: QualificationContext, requiredRoles: string[] = []) {
  if (requiredRoles.length) {
    const matched = context.contacts.find((contact) => {
      const title = contact.title ?? '';
      const normalized = contact.normalizedRole ?? '';
      return requiredRoles.some((role) => roleMatches(title, [role]) || roleMatches(normalized, [role]));
    });
    if (matched) return matched;
  }
  return context.contacts[0];
}

function evaluateConflicts(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence | null {
  const critical = new Set(['companyName', 'website', 'location', 'companySize', 'fullName', 'title', 'email', 'category', ...criteria.requiredFields]);
  const open = context.conflicts.filter((item) => item.requiresReview && item.resolutionStatus === 'OPEN' && critical.has(item.fieldName));
  const fieldConflicts = context.verifications.filter((item) => (item.status === 'CONFLICT' || item.status === 'NEEDS_REVIEW') && critical.has(item.field));
  if (!open.length && !fieldConflicts.length) return null;
  return evidence('conflicts', 'NEEDS_REVIEW', true, 'Critical required fields have unresolved verification conflicts.', {
    source: 'verification_conflicts',
    sourceUrl: null,
    excerpt: [...open.map((item) => item.fieldName), ...fieldConflicts.map((item) => item.field)].join(', '),
  }, 'NEEDS_REVIEW');
}

function evidence(
  criterion: string,
  result: CriterionResultCode,
  required: boolean,
  message: string,
  provenance: { source: string | null; sourceUrl: string | null; excerpt: string | null; evidenceId?: string; retrievedAt?: Date | null } | null,
  verificationStatus: string | null,
): CriterionEvidence {
  return {
    criterion,
    result,
    source: provenance?.source ?? null,
    sourceUrl: provenance?.sourceUrl ?? null,
    evidenceExcerpt: provenance?.excerpt ?? null,
    retrievedAt: provenance?.retrievedAt ? provenance.retrievedAt.toISOString() : null,
    verificationStatus,
    evidenceId: provenance?.evidenceId ?? null,
    required,
    message,
  };
}

function fieldStatus(context: QualificationContext, field: string) {
  return context.verifications.find((item) => item.field === field || item.field === field.toLowerCase())?.status ?? null;
}

/** True only when verification metadata explicitly records person-ownership evidence. */
function personEmailOwnershipVerified(context: QualificationContext): boolean {
  const row = context.verifications.find((item) => item.field === 'email' || item.field === 'personEmail');
  return row?.metadata?.ownershipVerified === true;
}

function findEvidence(evidence: QualificationContext['evidence'], patterns: RegExp[], options?: { requirePositiveIntent?: boolean }) {
  return evidence.find((item) => patterns.some((pattern) => {
    if (!pattern.test(item.evidenceText)) return false;
    if (!options?.requirePositiveIntent) return true;
    return !/\b(?:do\s+not|don't|does\s+not|doesn't|never|no longer)\s+[^.?]{0,20}\b(?:buy|purchase|acqui)/i.test(item.evidenceText);
  })) ?? null;
}

function parseEmployeeSpan(range: string | null): { min: number; max: number } | null {
  if (!range) return null;
  const match = range.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/i);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min, max };
}

function normalizeState(value: string) {
  const map: Record<string, string> = { texas: 'TX', tx: 'TX', california: 'CA', ca: 'CA', florida: 'FL', fl: 'FL', 'new york': 'NY', ny: 'NY' };
  return map[value.toLowerCase()] ?? value.toUpperCase();
}
