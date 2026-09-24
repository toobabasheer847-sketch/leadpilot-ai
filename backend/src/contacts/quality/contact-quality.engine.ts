import { matchContacts } from '../../deduplication/matching/matching';
import type { NormalizedContact } from '../../deduplication/types/deduplication.types';

export type ContactFieldStatus = 'VERIFIED' | 'SUPPORTED' | 'UNVERIFIED' | 'CONFLICT' | 'NOT_FOUND';
export type PhoneKind = 'COMPANY_PHONE' | 'PERSONAL_PUBLIC_PHONE' | 'UNKNOWN';

export interface ContactQualityEvidence {
  id: string;
  field: string;
  value: string;
  sourceType: string;
  sourceUrl: string;
  excerpt: string;
  retrievedAt: string;
}

export interface ContactQualityInput {
  contact: {
    id: string;
    fullName: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    facebookUrl: string | null;
    instagramUrl: string | null;
    youtubeUrl: string | null;
    companyRelationship: string | null;
    createdAt: string;
  };
  company: { id: string; name: string; website: string | null; phone: string | null };
  evidence: ContactQualityEvidence[];
  peers: Array<{ id: string; fullName: string; email: string | null; phone: string | null; linkedinUrl: string | null; title: string | null }>;
  targetRoles: string[];
  reverifyAfterDays: number;
  now?: string;
}

export interface FieldAssessment {
  status: ContactFieldStatus;
  value: string | null;
  evidenceIds: string[];
  independentSources: number;
  reason: string;
  phoneKind?: PhoneKind;
  ownershipVerified?: boolean;
}

export interface ContactQualityComponent {
  name: string;
  points: number;
  reason: string;
  evidenceId?: string;
}

export interface ContactQualityConflict {
  fieldName: string;
  valueA: string;
  valueB: string;
  sourceUrlA: string;
  sourceUrlB: string;
  sourceTypeA: string;
  sourceTypeB: string;
  retrievedAtA: string;
  retrievedAtB: string;
  evidenceExcerptA: string;
  evidenceExcerptB: string;
  requiresReview: true;
}

export interface ContactQualityResult {
  identityStatus: ContactFieldStatus;
  relationshipStatus: ContactFieldStatus;
  role: { storedTitle: string | null; matchedRole: string | null; historical: boolean; status: ContactFieldStatus };
  fields: Record<'name' | 'title' | 'email' | 'phone' | 'linkedin' | 'facebook' | 'instagram' | 'youtube', FieldAssessment>;
  conflicts: ContactQualityConflict[];
  duplicateStatus: 'NONE' | 'NEEDS_REVIEW';
  duplicateContactId: string | null;
  components: ContactQualityComponent[];
  qualityScore: number;
  discoveredAt: string;
  retrievedAt: string | null;
  lastVerifiedAt: string;
  independentSources: number;
}

const SOCIAL_HOSTS: Record<'linkedin' | 'facebook' | 'instagram' | 'youtube', string[]> = {
  linkedin: ['linkedin.com'],
  facebook: ['facebook.com'],
  instagram: ['instagram.com'],
  youtube: ['youtube.com', 'youtu.be'],
};

export function normalizeContactPhone(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export function evaluateContactQuality(input: ContactQualityInput): ContactQualityResult {
  const now = input.now ?? new Date().toISOString();
  const name = input.contact.fullName.trim();
  const companyLinked = evidenceLinksPersonToCompany(input);
  const independent = independentEvidence(input.evidence);
  const title = assessTitle(input, companyLinked);
  const email = assessEmail(input, companyLinked);
  const phone = assessPhone(input, companyLinked);
  const socials = {
    linkedin: assessSocial(input, 'linkedin', input.contact.linkedinUrl, companyLinked),
    facebook: assessSocial(input, 'facebook', input.contact.facebookUrl, companyLinked),
    instagram: assessSocial(input, 'instagram', input.contact.instagramUrl, companyLinked),
    youtube: assessSocial(input, 'youtube', input.contact.youtubeUrl, companyLinked),
  };
  const nameField = assessName(input, companyLinked);
  const conflicts = [...title.conflicts, ...email.conflicts, ...phone.conflicts];
  const duplicate = assessDuplicate(input);
  const fields = {
    name: withRecency(nameField, input),
    title: withRecency(title.assessment, input),
    email: withRecency(email.assessment, input),
    phone: withRecency(phone.assessment, input),
    linkedin: withRecency(socials.linkedin, input),
    facebook: withRecency(socials.facebook, input),
    instagram: withRecency(socials.instagram, input),
    youtube: withRecency(socials.youtube, input),
  };
  const linkedEvidence = input.evidence.filter((item) => excerptHasName(item, input.contact.fullName) && (excerptHasCompany(item, input.company.name) || sameHost(item.sourceUrl, input.company.website)));
  const relationshipBase = companyLinked ? (independentEvidence(linkedEvidence).length >= 2 ? 'VERIFIED' : 'SUPPORTED') : name ? 'UNVERIFIED' : 'NOT_FOUND';
  const relationshipStatus = applyRecency(relationshipBase, latestRetrievedAt(linkedEvidence), input.reverifyAfterDays, now);
  const components = scoreComponents({
    identityStatus: fields.name.status,
    relationshipStatus,
    role: fields.title,
    email: fields.email,
    socials: { linkedin: fields.linkedin, facebook: fields.facebook, instagram: fields.instagram, youtube: fields.youtube },
    independentSources: independent.length,
    retrievedAt: latestRetrievedAt(input.evidence),
    reverifyAfterDays: input.reverifyAfterDays,
    now,
    conflicts: conflicts.length,
  });
  const qualityScore = Math.max(0, Math.min(100, components.reduce((sum, item) => sum + item.points, 0)));
  return {
    identityStatus: fields.name.status,
    relationshipStatus,
    role: { storedTitle: input.contact.title, matchedRole: title.matchedRole, historical: title.historical, status: fields.title.status },
    fields,
    conflicts,
    duplicateStatus: duplicate.status,
    duplicateContactId: duplicate.contactId,
    components,
    qualityScore,
    discoveredAt: input.contact.createdAt,
    retrievedAt: latestRetrievedAt(input.evidence),
    lastVerifiedAt: now,
    independentSources: independent.length,
  };
}

function assessName(input: ContactQualityInput, companyLinked: boolean): FieldAssessment {
  const related = input.evidence.filter((item) => excerptHasName(item, input.contact.fullName));
  if (!input.contact.fullName.trim()) return emptyField('Name was not provided.');
  if (!related.length || !companyLinked) {
    return field('UNVERIFIED', input.contact.fullName, [], 0, 'The name is not tied to the target company by stored evidence.');
  }
  const sources = independentEvidence(related).length;
  return field(sources >= 2 ? 'VERIFIED' : 'SUPPORTED', input.contact.fullName, related.map((item) => item.id), sources, sources >= 2 ? 'Independent sources associate this name with the company.' : 'One source associates this name with the company.');
}

function assessTitle(input: ContactQualityInput, companyLinked: boolean) {
  const claims = input.evidence.filter((item) => item.field === 'title' || item.field === 'normalizedRole');
  const current = new Map<string, ContactQualityEvidence>();
  const historical = new Map<string, ContactQualityEvidence>();
  for (const claim of claims) {
    const parsed = parseTitle(claim.value);
    const bucket = parsed.historical ? historical : current;
    if (!bucket.has(parsed.normalized)) bucket.set(parsed.normalized, claim);
  }
  const conflicts: ContactQualityConflict[] = [];
  const currentValues = [...current.entries()];
  if (currentValues.length > 1) conflicts.push(conflict('title', currentValues[0][1], currentValues[1][1]));
  const historicalValues = [...historical.entries()];
  if (currentValues.length === 1 && historicalValues.length === 1 && currentValues[0][0] !== historicalValues[0][0]) {
    conflicts.push(conflict('title', currentValues[0][1], historicalValues[0][1]));
  }
  if (conflicts.length) {
    return {
      matchedRole: null,
      historical: historicalValues.length > 0,
      conflicts,
      assessment: field('CONFLICT', input.contact.title, claims.map((item) => item.id), independentEvidence(claims).length, 'Stored title evidence disagrees, so both claims are preserved.'),
    };
  }
  const selected = currentValues[0]?.[1] ?? historicalValues[0]?.[1] ?? null;
  const parsed = selected ? parseTitle(selected.value) : parseTitle(input.contact.title ?? '');
  const matchedRole = !parsed.historical && companyLinked ? matchConfiguredRole(parsed.normalized, input.targetRoles) : null;
  if (!selected) {
    return { matchedRole, historical: parsed.historical, conflicts, assessment: field(input.contact.title ? 'UNVERIFIED' : 'NOT_FOUND', input.contact.title, [], 0, input.contact.title ? 'No stored source supports the title.' : 'No title was discovered.') };
  }
  const matching = claims.filter((claim) => {
    const claimTitle = parseTitle(claim.value);
    return claimTitle.normalized === parsed.normalized && claimTitle.historical === parsed.historical;
  });
  const sources = independentEvidence(matching).length;
  const status = !companyLinked ? 'UNVERIFIED' : parsed.historical ? 'SUPPORTED' : sources >= 2 ? 'VERIFIED' : 'SUPPORTED';
  return {
    matchedRole,
    historical: parsed.historical,
    conflicts,
    assessment: field(status, input.contact.title ?? selected.value, matching.map((item) => item.id), sources, parsed.historical ? 'The title is historical and is not treated as the current role.' : 'The stored title is supported by source evidence.'),
  };
}

function assessEmail(input: ContactQualityInput, companyLinked: boolean) {
  const email = input.contact.email?.trim().toLowerCase() ?? null;
  const claims = input.evidence.filter((item) => item.field === 'email' && item.value.trim());
  const distinct = distinctValues(claims);
  const conflicts: ContactQualityConflict[] = [];
  if (distinct.length > 1) {
    conflicts.push(conflict('email', distinct[0], distinct[1]));
    return { conflicts, assessment: { ...field('CONFLICT', email, claims.map((item) => item.id), independentEvidence(claims).length, 'Sources disagree about the email address.'), ownershipVerified: false } };
  }
  if (!claims.length) return { conflicts, assessment: { ...field('NOT_FOUND', null, [], 0, 'No source provided an email address.'), ownershipVerified: false } };
  const value = (email ?? claims[0].value).trim().toLowerCase();
  const supporting = claims.filter((item) => item.value.trim().toLowerCase() === value && excerptHasName(item, input.contact.fullName));
  const domainOnly = companyDomain(input.company.website) === emailDomain(value);
  if (!supporting.length) {
    return { conflicts, assessment: { ...field('UNVERIFIED', value, [], 0, domainOnly ? 'A matching company domain is not evidence that the email belongs to this person.' : 'No stored evidence links this email to the person.'), ownershipVerified: false } };
  }
  const sources = independentEvidence(supporting).length;
  const status = companyLinked && sources >= 2 ? 'VERIFIED' : 'SUPPORTED';
  return { conflicts, assessment: { ...field(status, value, supporting.map((item) => item.id), sources, 'Evidence links the email address to this person.'), ownershipVerified: true } };
}

function assessPhone(input: ContactQualityInput, companyLinked: boolean) {
  const normalized = normalizeContactPhone(input.contact.phone);
  const companyPhone = normalizeContactPhone(input.company.phone);
  const claims = input.evidence.filter((item) => item.field === 'phone' && normalizeContactPhone(item.value));
  const distinct = [...new Map(claims.map((item) => [normalizeContactPhone(item.value), item])).values()];
  const conflicts: ContactQualityConflict[] = [];
  if (distinct.length > 1) {
    conflicts.push(conflict('phone', distinct[0], distinct[1]));
    return { conflicts, assessment: withPhone(field('CONFLICT', normalized, claims.map((item) => item.id), independentEvidence(claims).length, 'Sources disagree about the phone number.'), 'UNKNOWN', false) };
  }
  if (!claims.length) return { conflicts, assessment: withPhone(field('NOT_FOUND', null, [], 0, 'No source provided a phone number.'), 'UNKNOWN', false) };
  const value = normalized ?? normalizeContactPhone(claims[0].value);
  const personal = claims.filter((item) => phoneAssignedToPerson(item, input.contact.fullName, value ?? ''));
  const sameAsCompany = Boolean(value && companyPhone && value === companyPhone);
  if (!personal.length || sameAsCompany) {
    return { conflicts, assessment: withPhone(field('UNVERIFIED', value, [], 0, sameAsCompany ? 'The company phone is not treated as this person\'s phone.' : 'No evidence assigns this phone number to the person.'), sameAsCompany ? 'COMPANY_PHONE' : 'UNKNOWN', false) };
  }
  const sources = independentEvidence(personal).length;
  return { conflicts, assessment: withPhone(field(companyLinked && sources >= 2 ? 'VERIFIED' : 'SUPPORTED', value, personal.map((item) => item.id), sources, 'A public source assigns this phone number to the person.'), 'PERSONAL_PUBLIC_PHONE', true) };
}

function assessSocial(input: ContactQualityInput, platform: keyof typeof SOCIAL_HOSTS, url: string | null, companyLinked: boolean): FieldAssessment {
  if (!url?.trim()) return field('NOT_FOUND', null, [], 0, `No ${platform} profile was discovered.`);
  if (!profileHostMatches(url, platform)) return field('UNVERIFIED', url, [], 0, `The stored ${platform} URL is not a recognized public profile host.`);
  const claims = input.evidence.filter((item) => item.field === platform || item.field === `${platform}Url` || (item.field === 'profileUrl' && profileHostMatches(item.value, platform)));
  const linked = claims.filter((item) => excerptHasName(item, input.contact.fullName) && (excerptHasCompany(item, input.company.name) || sameHost(item.sourceUrl, input.company.website)));
  if (!linked.length || !companyLinked) return field('UNVERIFIED', url, [], 0, `Stored evidence does not establish that this ${platform} profile belongs to the person at the company.`);
  const sources = independentEvidence(linked).length;
  return field(sources >= 2 ? 'VERIFIED' : 'SUPPORTED', url, linked.map((item) => item.id), sources, `Evidence links the ${platform} profile to this person and company.`);
}

function assessDuplicate(input: ContactQualityInput): { status: 'NONE' | 'NEEDS_REVIEW'; contactId: string | null } {
  const current = toNormalized(input.contact.id, input.company.id, input.contact);
  for (const peer of input.peers) {
    if (peer.id === input.contact.id) continue;
    if (normalizePersonName(peer.fullName) !== normalizePersonName(input.contact.fullName) && !sameStrongIdentifier(input.contact, peer)) continue;
    const decision = matchContacts(current, toNormalized(peer.id, input.company.id, peer));
    if (decision.status === 'AUTO_DUPLICATE' || decision.status === 'REVIEW_REQUIRED' || decision.status === 'CONFLICT') {
      return { status: 'NEEDS_REVIEW', contactId: peer.id };
    }
  }
  return { status: 'NONE', contactId: null };
}

function evidenceLinksPersonToCompany(input: ContactQualityInput) {
  return input.evidence.some((item) => excerptHasName(item, input.contact.fullName) && (excerptHasCompany(item, input.company.name) || sameHost(item.sourceUrl, input.company.website)));
}

function withRecency(assessment: FieldAssessment, input: ContactQualityInput): FieldAssessment {
  const related = input.evidence.filter((item) => assessment.evidenceIds.includes(item.id));
  return { ...assessment, status: applyRecency(assessment.status, latestRetrievedAt(related), input.reverifyAfterDays, input.now ?? new Date().toISOString()) };
}

function scoreComponents(input: {
  identityStatus: ContactFieldStatus;
  relationshipStatus: ContactFieldStatus;
  role: FieldAssessment;
  email: FieldAssessment;
  socials: Record<string, FieldAssessment>;
  independentSources: number;
  retrievedAt: string | null;
  reverifyAfterDays: number;
  now: string;
  conflicts: number;
}): ContactQualityComponent[] {
  const pointsFor = (status: ContactFieldStatus, verified: number, supported: number) => status === 'VERIFIED' ? verified : status === 'SUPPORTED' ? supported : status === 'CONFLICT' ? -supported : 0;
  const social = Object.values(input.socials).some((item) => item.status === 'VERIFIED') ? 10 : Object.values(input.socials).some((item) => item.status === 'SUPPORTED') ? 5 : 0;
  const ageDays = input.retrievedAt ? Math.max(0, (Date.parse(input.now) - Date.parse(input.retrievedAt)) / 86400000) : null;
  const fresh = ageDays === null ? 0 : ageDays <= input.reverifyAfterDays ? 10 : 4;
  return [
    { name: 'identity', points: pointsFor(input.identityStatus, 20, 10), reason: `Identity status is ${input.identityStatus}.` },
    { name: 'company_relationship', points: pointsFor(input.relationshipStatus, 15, 8), reason: `Company relationship status is ${input.relationshipStatus}.` },
    { name: 'role_evidence', points: pointsFor(input.role.status, 20, 10), reason: input.role.reason, evidenceId: input.role.evidenceIds[0] },
    { name: 'email_evidence', points: pointsFor(input.email.status, 15, 8), reason: input.email.reason, evidenceId: input.email.evidenceIds[0] },
    { name: 'social_evidence', points: social, reason: social > 0 ? 'At least one social profile is supported by evidence.' : 'No social profile is supported by evidence.' },
    { name: 'source_independence', points: Math.min(10, input.independentSources * 5), reason: `${input.independentSources} independent source(s) remain after collapsing duplicate URLs.` },
    { name: 'evidence_recency', points: fresh, reason: ageDays === null ? 'No evidence timestamp is available.' : `Latest evidence is ${Math.round(ageDays)} days old.` },
    { name: 'conflicts', points: input.conflicts > 0 ? -10 : 0, reason: input.conflicts > 0 ? `${input.conflicts} field conflict(s) require review.` : 'No field conflicts were found.' },
  ];
}

function applyRecency(status: ContactFieldStatus, retrievedAt: string | null, days: number, now: string): ContactFieldStatus {
  if (status !== 'VERIFIED' || !retrievedAt) return status;
  const age = (Date.parse(now) - Date.parse(retrievedAt)) / 86400000;
  return age > days ? 'SUPPORTED' : status;
}

function withPhone(assessment: FieldAssessment, phoneKind: PhoneKind, ownershipVerified: boolean): FieldAssessment {
  return { ...assessment, phoneKind, ownershipVerified };
}

function field(status: ContactFieldStatus, value: string | null, evidenceIds: string[], independentSources: number, reason: string): FieldAssessment {
  return { status, value, evidenceIds, independentSources, reason };
}

function emptyField(reason: string): FieldAssessment {
  return field('NOT_FOUND', null, [], 0, reason);
}

function conflict(fieldName: string, left: ContactQualityEvidence, right: ContactQualityEvidence): ContactQualityConflict {
  return {
    fieldName,
    valueA: left.value,
    valueB: right.value,
    sourceTypeA: left.sourceType,
    sourceTypeB: right.sourceType,
    sourceUrlA: left.sourceUrl,
    sourceUrlB: right.sourceUrl,
    retrievedAtA: left.retrievedAt,
    retrievedAtB: right.retrievedAt,
    evidenceExcerptA: left.excerpt,
    evidenceExcerptB: right.excerpt,
    requiresReview: true,
  };
}

function parseTitle(value: string) {
  const normalized = value.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const historical = /^(former|ex|previous)\b/.test(normalized);
  return { normalized: normalized.replace(/^(former|ex|previous)\s+/, ''), historical };
}

function matchConfiguredRole(title: string, roles: string[]) {
  const match = roles.find((role) => parseTitle(role).normalized === title);
  return match ?? null;
}

function excerptHasName(item: ContactQualityEvidence, fullName: string) {
  return item.excerpt.toLowerCase().includes(normalizePersonName(fullName));
}

function excerptHasCompany(item: ContactQualityEvidence, companyName: string) {
  return `${item.excerpt} ${item.value}`.toLowerCase().includes(companyName.trim().toLowerCase());
}

function profileHostMatches(url: string, platform: keyof typeof SOCIAL_HOSTS) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return SOCIAL_HOSTS[platform].includes(host);
  } catch {
    return false;
  }
}

function sameHost(sourceUrl: string, website: string | null) {
  if (!website) return false;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, '') === new URL(website).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

function emailDomain(email: string) {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

function companyDomain(website: string | null) {
  if (!website) return '';
  try { return new URL(website).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function independentEvidence(items: ContactQualityEvidence[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const excerpt = item.excerpt.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = excerpt.length >= 80 ? `copy|${excerpt}` : `${item.sourceType}|${canonicalSourceUrl(item.sourceUrl)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function phoneAssignedToPerson(item: ContactQualityEvidence, fullName: string, phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return false;
  return item.excerpt.split(/[.\n]/).some((sentence) => sentence.replace(/\D/g, '').includes(digits) && excerptHasName({ ...item, excerpt: sentence, value: '' }, fullName));
}

export function contactAccessAllowed(resourceOrganizationId: string, actorOrganizationId: string) {
  return resourceOrganizationId === actorOrganizationId;
}

export function canonicalSourceUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

function distinctValues(items: ContactQualityEvidence[]) {
  const map = new Map<string, ContactQualityEvidence>();
  for (const item of items) {
    const key = item.value.trim().toLowerCase();
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function latestRetrievedAt(items: ContactQualityEvidence[]) {
  const stamps = items.map((item) => item.retrievedAt).filter(Boolean).sort();
  return stamps.at(-1) ?? null;
}

function normalizePersonName(value: string) {
  return value.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function sameStrongIdentifier(contact: ContactQualityInput['contact'], peer: ContactQualityInput['peers'][number]) {
  return Boolean(
    (contact.email && peer.email && contact.email.toLowerCase() === peer.email.toLowerCase())
    || (contact.linkedinUrl && peer.linkedinUrl && contact.linkedinUrl === peer.linkedinUrl)
    || (normalizeContactPhone(contact.phone) && normalizeContactPhone(contact.phone) === normalizeContactPhone(peer.phone)),
  );
}

function toNormalized(id: string, companyId: string, contact: { fullName: string; email: string | null; phone: string | null; linkedinUrl: string | null; title: string | null }): NormalizedContact {
  return {
    id,
    companyId,
    name: normalizePersonName(contact.fullName),
    email: contact.email?.toLowerCase() ?? null,
    phone: normalizeContactPhone(contact.phone),
    socialUrls: [contact.linkedinUrl].filter((item): item is string => Boolean(item)),
    title: contact.title,
  };
}
