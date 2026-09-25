import type { SearchPlan } from '../../search/types/search-plan.types';
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

export function normalizeCriteria(plan: SearchPlan | null | undefined): QualificationCriteria {
  const requiredRoles = plan?.requiredRoles?.length
    ? plan.requiredRoles
    : plan?.contactRequirements?.titles ?? [];
  const requiredFields = [...new Set([
    ...(plan?.requiredFields ?? []),
    'companyName',
    ...(plan?.locations?.length ? ['location'] as const : []),
    ...(plan?.companySize ? ['companySize'] as const : []),
    ...(requiredRoles.length ? ['decisionMaker'] as const : []),
    ...((plan?.industry?.length || plan?.leadTypes?.length) ? ['category'] as const : []),
  ])];
  const optionalFields = [...new Set((plan?.optionalFields ?? plan?.companyFields ?? []).concat(plan?.contactRequirements?.fields ?? []).filter((field) => !requiredFields.includes(field) && field !== 'name'))];
  return {
    industry: plan?.industry ?? [],
    leadTypes: plan?.leadTypes ?? [],
    locations: plan?.locations ?? [],
    companySize: plan?.companySize,
    requiredRoles,
    requiredFields,
    optionalFields,
    minimumScore: plan?.minimumScore,
  };
}

export function evaluateQualification(context: QualificationContext, criteria: QualificationCriteria): QualificationDecision {
  const results: CriterionEvidence[] = [];

  results.push(evaluateIdentity(context));
  if (criteria.requiredFields.includes('website') || criteria.optionalFields.includes('website')) {
    results.push(evaluateFieldPresence(context, 'website', context.company.website, criteria.requiredFields.includes('website')));
  }
  if (criteria.locations.length) results.push(evaluateLocation(context, criteria));
  if (criteria.companySize) results.push(evaluateCompanySize(context, criteria));
  if (criteria.industry.length || criteria.leadTypes.length) results.push(evaluateCategory(context, criteria));
  if (criteria.requiredRoles.length) results.push(evaluateDecisionMaker(context, criteria));

  for (const field of ['email', 'phone', 'linkedin', 'facebook', 'instagram', 'youtube'] as const) {
    if (criteria.requiredFields.includes(field) || criteria.optionalFields.includes(field)) {
      results.push(evaluateContactField(context, field, criteria.requiredFields.includes(field)));
    }
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

  // Score never overrides required criteria failures.
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

function evaluateFieldPresence(context: QualificationContext, field: string, value: string | null, required: boolean): CriterionEvidence {
  const verification = fieldStatus(context, field);
  if (!value) return evidence(field, 'NOT_FOUND', required, `${field} was not found.`, null, verification);
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence(field, 'NEEDS_REVIEW', required, `${field} has conflicting verification evidence.`, { source: 'verification', sourceUrl: value, excerpt: value }, verification);
  }
  return evidence(field, 'MATCH', required, `${field} is available${verification === 'VERIFIED' || verification === 'SUPPORTED' ? ` and ${verification.toLowerCase()}` : ''}.`, {
    source: 'company_record',
    sourceUrl: value,
    excerpt: value,
  }, verification);
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
  const match = criteria.locations.some((wanted) => {
    const countryOk = !wanted.country || !context.location?.country || wanted.country.toLowerCase() === context.location.country.toLowerCase();
    const stateOk = !wanted.state || (context.location?.state && normalizeState(wanted.state) === normalizeState(context.location.state));
    const cityOk = !wanted.city || (context.location?.city && wanted.city.toLowerCase() === context.location.city.toLowerCase());
    return countryOk && stateOk && cityOk;
  });
  return evidence('location', match ? 'MATCH' : 'NO_MATCH', true, match
    ? `Location matched requested criteria (${[context.location.state, context.location.country].filter(Boolean).join(', ')}).`
    : `Location did not match requested criteria (found ${[context.location.city, context.location.state, context.location.country].filter(Boolean).join(', ') || 'unknown'}).`, {
    source: 'company_locations',
    sourceUrl: null,
    excerpt: [context.location.city, context.location.state, context.location.country].filter(Boolean).join(', '),
  }, verification);
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
    const industryHit = relevantEvidence.find((item) => criteria.industry.some((industry) => item.evidenceText.toLowerCase().includes(industry.replace(/_/g, ' ')) || (context.company.category ?? '').toLowerCase().includes(industry.replace(/_/g, ' '))));
    if (industryHit || (context.company.category && criteria.industry.some((industry) => context.company.category!.toLowerCase().includes(industry.replace(/_/g, ' '))))) {
      return evidence('category', 'MATCH', true, 'Industry/category evidence matched the requested search criteria.', {
        source: industryHit?.provider ?? industryHit?.sourceType ?? 'company_record',
        sourceUrl: industryHit?.sourceUrl ?? context.company.website,
        excerpt: industryHit?.evidenceText ?? context.company.category,
        evidenceId: industryHit?.id,
        retrievedAt: industryHit?.retrievedAt ?? null,
      }, null);
    }
    return evidence('category', 'NOT_FOUND', true, 'No legitimate industry/category evidence was found for the requested criteria.', null, null);
  }

  return evidence('category', 'MATCH', false, 'No category criteria were requested.', null, null);
}

function evaluateDecisionMaker(context: QualificationContext, criteria: QualificationCriteria): CriterionEvidence {
  const contacts = context.contacts.filter((contact) => contact.fullName);
  if (!contacts.length) {
    return evidence('decisionMaker', 'NOT_FOUND', true, 'No reliable decision-maker was found.', null, null);
  }
  const roleMatch = contacts.find((contact) => {
    const haystack = `${contact.title ?? ''} ${contact.normalizedRole ?? ''}`.toLowerCase();
    return criteria.requiredRoles.some((role) => haystack.includes(role.toLowerCase()) || haystack.includes(role.replace(/_/g, ' ').toLowerCase()));
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

function evaluateContactField(context: QualificationContext, field: string, required: boolean): CriterionEvidence {
  const contact = context.contacts[0];
  const value = field === 'email' ? contact?.email ?? context.company.email
    : field === 'phone' ? contact?.phone ?? context.company.phone
      : field === 'linkedin' ? contact?.linkedinUrl
        : field === 'facebook' ? contact?.facebookUrl
          : field === 'instagram' ? contact?.instagramUrl
            : contact?.youtubeUrl ?? null;
  const verification = fieldStatus(context, field);
  if (!value) return evidence(field, 'NOT_FOUND', required, `${field} was not found.`, null, verification);
  if (verification === 'CONFLICT' || verification === 'NEEDS_REVIEW') {
    return evidence(field, 'NEEDS_REVIEW', required, `${field} has conflicting verification evidence.`, { source: 'verification', sourceUrl: null, excerpt: value }, verification);
  }
  if (required && verification !== 'VERIFIED' && verification !== 'SUPPORTED' && /email|phone/.test(field)) {
    return evidence(field, 'NEEDS_REVIEW', required, `${field} exists but is not verified/supported.`, { source: 'contact_record', sourceUrl: null, excerpt: value }, verification ?? 'UNVERIFIED');
  }
  return evidence(field, 'MATCH', required, `${field} is available.`, { source: 'contact_record', sourceUrl: null, excerpt: value }, verification);
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
