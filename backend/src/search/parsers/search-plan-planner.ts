import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouterProvider } from '../../ai/classification/providers/openrouter.provider';
import { UsageService } from '../../usage/usage.service';
import { RESULT_SAFETY_CAP } from '../search-plan.limits';
import { interpretPlace } from '../search-plan.places';
import type { CompanySize, SearchLocation, SearchPlan, UnresolvedCriterion } from '../types/search-plan.types';
import { SearchPlanParser, verificationIntentNegated } from './search-plan.parser';

const PLAN_FIELDS = [
  'companyWebsite', 'companyEmail', 'companyPhone', 'companyLinkedin', 'companyFacebook', 'companyInstagram', 'companyYoutube', 'companyX',
  'employeeCount', 'location', 'industry',
  'personName', 'personTitle', 'personEmail', 'personPhone', 'personLinkedin', 'personFacebook', 'personInstagram', 'personYoutube', 'personX',
  'website', 'email', 'phone', 'name', 'title', 'linkedin', 'facebook', 'instagram', 'x', 'youtube',
] as const;

const SOCIAL_PLATFORMS = ['linkedin', 'facebook', 'instagram', 'x', 'youtube'] as const;

const SEARCH_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requestedCount: nullable({ type: 'integer', minimum: 1, maximum: 100000 }),
    countIntent: nullable({ type: 'string', enum: ['exact', 'maximum', 'minimum', 'approximate'] }),
    targetType: { type: 'string', enum: ['COMPANIES', 'QUALIFIED_LEADS'] },
    industry: stringArray(),
    leadTypes: stringArray(),
    locations: {
      type: 'array',
      items: strictObject({
        rawText: { type: 'string' },
        country: nullable({ type: 'string' }),
        state: nullable({ type: 'string' }),
        city: nullable({ type: 'string' }),
        region: nullable({ type: 'string' }),
        postalCode: nullable({ type: 'string' }),
      }),
    },
    employeeSize: nullable(strictObject({
      min: nullable({ type: 'integer', minimum: 0 }),
      max: nullable({ type: 'integer', minimum: 0 }),
      exact: nullable({ type: 'integer', minimum: 0 }),
      qualitative: nullable({ type: 'string' }),
      sourceText: { type: 'string' },
    })),
    decisionMakerRoles: stringArray(),
    requiredFields: enumArray(PLAN_FIELDS),
    preferredFields: enumArray(PLAN_FIELDS),
    companyFields: enumArray(['companyWebsite', 'companyEmail', 'companyPhone', 'companyLinkedin', 'companyFacebook', 'companyInstagram', 'companyYoutube', 'companyX', 'employeeCount', 'location', 'industry', 'website', 'email', 'phone', ...SOCIAL_PLATFORMS]),
    personFields: enumArray(['personName', 'personTitle', 'personEmail', 'personPhone', 'personLinkedin', 'personFacebook', 'personInstagram', 'personYoutube', 'personX', 'name', 'title', 'email', 'phone', ...SOCIAL_PLATFORMS]),
    socialPlatforms: enumArray(SOCIAL_PLATFORMS),
    emailRequirement: strictObject({ requested: { type: 'boolean' }, required: { type: 'boolean' }, verified: { type: 'boolean' } }),
    websiteRequirement: strictObject({ requested: { type: 'boolean' }, required: { type: 'boolean' } }),
    verificationRequirement: strictObject({ requested: { type: 'boolean' }, required: { type: 'boolean' }, fields: stringArray() }),
    minimumScore: nullable({ type: 'integer', minimum: 0, maximum: 100 }),
    unresolvedRequirements: {
      type: 'array',
      items: strictObject({ text: { type: 'string' }, reason: { type: 'string' }, sourceText: { type: 'string' } }),
    },
    evidenceQuotes: {
      type: 'array',
      items: strictObject({ field: { type: 'string' }, value: { type: 'string' }, quote: { type: 'string' } }),
    },
  },
  required: [
    'requestedCount', 'countIntent', 'targetType', 'industry', 'leadTypes', 'locations', 'employeeSize',
    'decisionMakerRoles', 'requiredFields', 'preferredFields', 'companyFields', 'personFields', 'socialPlatforms',
    'emailRequirement', 'websiteRequirement', 'verificationRequirement', 'minimumScore', 'unresolvedRequirements', 'evidenceQuotes',
  ],
};

const PLANNER_SYSTEM_PROMPT = `Convert the user's prompt into the supplied strict search-plan JSON schema.
Extract only requirements actually stated by the user. Do not add conventional defaults, numeric interpretations of qualitative sizes, radii, countries, contact fields, or verification requirements.
Use targetType QUALIFIED_LEADS only when the user explicitly asks for qualified leads; otherwise use COMPANIES.
Keep countIntent exact, maximum, minimum, or approximate according to the wording. A requested count is not a promise of qualified results.
Keep industry/category separate from leadTypes/business intent. Do not infer a real-estate investor from generic investment-company wording.
Use rawText to preserve every requested location exactly; fill geographic components only when stated or confidently normalized. Do not infer a radius for near/around.
For employeeSize, use exact/min/max only when the prompt states numbers. Put qualitative words such as small in qualitative and leave numeric values null.
Separate companyFields from personFields. Plain email is not verified email. Put only explicit hard requirements in requiredFields; put soft preferences in preferredFields.
Every extracted value must have an evidenceQuotes entry whose quote is an exact substring of the user's prompt and whose value is supported by that quote. Record ambiguous or underspecified requests in unresolvedRequirements with an exact sourceText. Do not invent data values; this is a plan, not lead data.
Return only schema-conforming JSON.`;

interface EvidenceQuote {
  field: string;
  value: string;
  quote: string;
}

interface PlannerDraft {
  requestedCount: number | null;
  countIntent: SearchPlan['countIntent'] | null;
  targetType: 'COMPANIES' | 'QUALIFIED_LEADS';
  industry: string[];
  leadTypes: string[];
  locations: Array<{ rawText: string; country: string | null; state: string | null; city: string | null; region: string | null; postalCode: string | null }>;
  employeeSize: { min: number | null; max: number | null; exact: number | null; qualitative: string | null; sourceText: string } | null;
  decisionMakerRoles: string[];
  requiredFields: string[];
  preferredFields: string[];
  companyFields: string[];
  personFields: string[];
  socialPlatforms: string[];
  emailRequirement: { requested: boolean; required: boolean; verified: boolean };
  websiteRequirement: { requested: boolean; required: boolean };
  verificationRequirement: { requested: boolean; required: boolean; fields: string[] };
  minimumScore: number | null;
  unresolvedRequirements: Array<{ text: string; reason: string; sourceText: string }>;
  evidenceQuotes: EvidenceQuote[];
}

@Injectable()
export class SearchPlanPlanner {
  constructor(
    private readonly openRouter: OpenRouterProvider,
    private readonly parser: SearchPlanParser,
    private readonly config: ConfigService,
    private readonly usage: UsageService,
  ) {}

  async plan(prompt: string, context: { organizationId: string; userId: string }): Promise<SearchPlan> {
    const fallback = this.withPlanning(this.parser.parse(prompt), 'deterministic_fallback');
    const model = this.config.get<string>('openRouter.model')?.trim();
    let requestStarted = false;
    try {
      await this.usage.checkRequestRate(context.organizationId, context.userId, 'AI_CLASSIFICATION');
      await this.usage.assertDailyQuota(context.organizationId, 'AI_CLASSIFICATION');
      requestStarted = true;
      const response = await this.openRouter.completeJson(PLANNER_SYSTEM_PROMPT, prompt, SEARCH_PLAN_SCHEMA);
      const draft = validateDraft(response, prompt, fallback);
      const plan = normalizeDraft(draft, prompt, fallback);
      await this.usage.recordUsage({ organizationId: context.organizationId, userId: context.userId, operation: 'AI_CLASSIFICATION', provider: 'openrouter-search-planner', resourceType: 'search_plan', units: 1, status: 'COMPLETED', metadata: { model: model ?? 'unknown', planner: 'ai' } });
      return { ...plan, planning: { method: 'ai', ...(model ? { model } : {}) } };
    } catch (error) {
      const message = safeError(error);
      if (requestStarted) {
        try {
          await this.usage.recordUsage({ organizationId: context.organizationId, userId: context.userId, operation: 'AI_CLASSIFICATION', provider: 'openrouter-search-planner', resourceType: 'search_plan', units: 1, status: 'FAILED', metadata: { model: model ?? 'unknown', planner: 'ai', error: message } });
        } catch {
          // Planning still has a deterministic fallback if usage recording is unavailable.
        }
      }
      return { ...fallback, planning: { method: 'deterministic_fallback', ...(model ? { model } : {}), error: message } };
    }
  }

  private withPlanning(plan: SearchPlan, method: 'ai' | 'deterministic_fallback'): SearchPlan {
    const unresolvedRequirements = plan.unresolvedRequirements ?? plan.unresolvedCriteria;
    return {
      ...plan,
      planning: { method },
      unresolvedRequirements,
      originalPrompt: plan.originalPrompt,
    };
  }
}

function validateDraft(value: unknown, prompt: string, fallback: SearchPlan): PlannerDraft {
  if (!isRecord(value)) throw new Error('Planner returned a non-object response.');
  assertKeys(value, [
    'requestedCount', 'countIntent', 'targetType', 'industry', 'leadTypes', 'locations', 'employeeSize',
    'decisionMakerRoles', 'requiredFields', 'preferredFields', 'companyFields', 'personFields', 'socialPlatforms',
    'emailRequirement', 'websiteRequirement', 'verificationRequirement', 'minimumScore', 'unresolvedRequirements', 'evidenceQuotes',
  ], 'planner response');
  const draft = value as unknown as PlannerDraft;
  if (!Array.isArray(draft.industry) || !Array.isArray(draft.leadTypes) || !Array.isArray(draft.locations)
    || !Array.isArray(draft.decisionMakerRoles) || !Array.isArray(draft.requiredFields) || !Array.isArray(draft.preferredFields)
    || !Array.isArray(draft.companyFields) || !Array.isArray(draft.personFields) || !Array.isArray(draft.socialPlatforms)
    || !Array.isArray(draft.unresolvedRequirements) || !Array.isArray(draft.evidenceQuotes)) {
    throw new Error('Planner response is missing required arrays.');
  }
  if (draft.targetType !== 'COMPANIES' && draft.targetType !== 'QUALIFIED_LEADS') throw new Error('Planner returned an invalid target type.');
  if (draft.countIntent != null && !['exact', 'maximum', 'minimum', 'approximate'].includes(draft.countIntent)) throw new Error('Planner returned an invalid count intent.');
  if (draft.requestedCount != null && (!Number.isInteger(draft.requestedCount) || draft.requestedCount < 1)) throw new Error('Planner returned an invalid requested count.');
  for (const [label, items] of Object.entries({
    industry: draft.industry, leadTypes: draft.leadTypes, decisionMakerRoles: draft.decisionMakerRoles,
    requiredFields: draft.requiredFields, preferredFields: draft.preferredFields, companyFields: draft.companyFields,
    personFields: draft.personFields, socialPlatforms: draft.socialPlatforms,
  })) {
    if (items.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`Planner returned invalid ${label}.`);
  }
  if (fallback.requestedCount != null && draft.requestedCount !== fallback.requestedCount) throw new Error('Planner count differs from the explicit prompt count.');
  if (draft.requestedCount != null && draft.requestedCount !== fallback.requestedCount) {
    // When the deterministic parser did not see a count, require prompt-grounded evidence.
    requireGrounded(draft, 'requestedCount', String(draft.requestedCount), prompt, (quote) =>
      countMentioned(quote, draft.requestedCount as number) || (new RegExp(`\\b${draft.requestedCount}\\b`).test(quote) && countMentioned(prompt, draft.requestedCount as number)));
  }
  if (draft.targetType === 'QUALIFIED_LEADS' && !/\bqualified\s+leads?\b/i.test(prompt)) throw new Error('Planner inferred a qualified-lead target not stated by the user.');

  for (const industry of draft.industry) {
    if (!phraseGroundedInPrompt(prompt, industry)) {
      requireGrounded(draft, 'industry', industry, prompt, (quote) => hasPhrase(quote, industry));
    }
  }
  for (const type of draft.leadTypes) {
    const quote = quoteFor(draft, 'leadTypes', type) || quoteForFlexible(draft, 'leadTypes', type);
    const standardMatch = hasPhrase(quote || prompt, type);
    const investorMatch = /real[ _-]?estate.*investor|investor.*real[ _-]?estate/i.test(type)
      && /real[ -]?estate|property/i.test(quote || prompt) && /invest(?:or|ment)|acquisition|buyer/i.test(quote || prompt);
    if (!phraseGroundedInPrompt(prompt, type) && (!quote || !includesNormalized(prompt, quote) || (!standardMatch && !investorMatch))) {
      throw new Error(`Planner lead type is not grounded in the prompt (${type}).`);
    }
    if (/real[ _-]?estate.*investor|investor.*real[ _-]?estate/i.test(type)
      && !/real[ -]?estate|property/i.test(prompt)) {
      throw new Error('Planner inferred real-estate investment intent without a real-estate phrase.');
    }
  }
  for (const location of draft.locations) {
    if (!isRecord(location) || typeof location.rawText !== 'string' || !location.rawText.trim()) throw new Error('Planner returned a location without original text.');
    assertKeys(location, ['rawText', 'country', 'state', 'city', 'region', 'postalCode'], 'planner location');
    if (!includesNormalized(prompt, location.rawText)) throw new Error('Planner location rawText is not present in the prompt.');
    const coveredByFallback = fallback.locations.some((expected) => {
      const terms = [expected.originalText, expected.city, expected.state, expected.region, expected.country].filter((item): item is string => Boolean(item));
      return terms.some((term) => includesNormalized(location.rawText, term) || includesNormalized(term, location.rawText));
    });
    if (!coveredByFallback) {
      const quote = quoteForLocation(draft, location.rawText);
      if (!quote || !includesNormalized(prompt, quote) || !(includesNormalized(quote, location.rawText) || includesNormalized(location.rawText, quote))) {
        throw new Error(`Planner requirement is not grounded in the prompt (locations: ${location.rawText}).`);
      }
    }
    const known = interpretPlace(location.rawText);
    for (const component of ['country', 'state', 'city', 'region', 'postalCode'] as const) {
      const part = location[component];
      if (part != null && typeof part !== 'string') throw new Error('Planner returned an invalid location component.');
      if (part && !locationComponentAllowed(component, part, location.rawText, known)) {
        throw new Error(`Planner inferred an unsupported location component (${component}).`);
      }
    }
  }

  if (draft.employeeSize) {
    assertKeys(draft.employeeSize, ['min', 'max', 'exact', 'qualitative', 'sourceText'], 'planner employee size');
    const size = draft.employeeSize;
    if (typeof size.sourceText !== 'string' || !includesNormalized(prompt, size.sourceText)) throw new Error('Planner employee-size evidence is not present in the prompt.');
    const numericBounds = [size.min, size.max, size.exact].filter((item) => item != null);
    if (numericBounds.some((item) => !Number.isInteger(item) || (item as number) < 0)) throw new Error('Planner returned invalid employee-size bounds.');
    if (numericBounds.some((item) => !new RegExp(`\\b${item}\\b`).test(size.sourceText)) || (numericBounds.length > 0 && !/employee|company\s+size|staff|headcount/i.test(size.sourceText))) {
      throw new Error('Planner invented a numeric employee-size bound.');
    }
    if (size.qualitative && !includesNormalized(size.sourceText, size.qualitative)) throw new Error('Planner returned unsupported qualitative employee size.');
    if (size.exact != null && (size.min != null || size.max != null)) throw new Error('Planner mixed exact employee size with a range.');
  }

  for (const role of draft.decisionMakerRoles) {
    if (!roleMentioned(prompt, role) && !phraseGroundedInPrompt(prompt, role)) {
      requireGrounded(draft, 'decisionMakerRoles', role, prompt, (quote) => roleMentioned(quote, role));
    }
  }
  for (const field of [...draft.requiredFields, ...draft.preferredFields, ...draft.companyFields, ...draft.personFields]) {
    if (!(PLAN_FIELDS as readonly string[]).includes(field)) throw new Error(`Planner returned an unsupported field (${field}).`);
    requireGrounded(draft, 'fields', field, prompt, (quote) => fieldMentioned(quote, field));
  }
  for (const platform of draft.socialPlatforms) {
    if (!(SOCIAL_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`Planner returned an unsupported social platform (${platform}).`);
    requireGrounded(draft, 'socialPlatforms', platform, prompt, (quote) => fieldMentioned(quote, platform) || /\b(?:company\s+)?social\s+(?:profiles?|media|accounts?)\b|\bsocials\b/i.test(quote));
  }
  for (const item of draft.unresolvedRequirements) {
    if (!isRecord(item) || typeof item.text !== 'string' || typeof item.reason !== 'string' || typeof item.sourceText !== 'string'
      || !includesNormalized(prompt, item.sourceText) || !includesNormalized(item.sourceText, item.text)) {
      throw new Error('Planner returned an unresolved requirement without a matching source quote.');
    }
    assertKeys(item, ['text', 'reason', 'sourceText'], 'planner unresolved requirement');
  }
  if (!isRecord(draft.emailRequirement) || !isRecord(draft.websiteRequirement) || !isRecord(draft.verificationRequirement)
    || !Array.isArray(draft.verificationRequirement.fields)) throw new Error('Planner returned invalid requirement metadata.');
  assertKeys(draft.emailRequirement, ['requested', 'required', 'verified'], 'planner email requirement');
  assertKeys(draft.websiteRequirement, ['requested', 'required'], 'planner website requirement');
  assertKeys(draft.verificationRequirement, ['requested', 'required', 'fields'], 'planner verification requirement');
  if ([draft.emailRequirement.requested, draft.emailRequirement.required, draft.emailRequirement.verified,
    draft.websiteRequirement.requested, draft.websiteRequirement.required,
    draft.verificationRequirement.requested, draft.verificationRequirement.required].some((item) => typeof item !== 'boolean')) {
    throw new Error('Planner returned invalid requirement flags.');
  }
  if (draft.verificationRequirement.fields.some((field) => typeof field !== 'string')) throw new Error('Planner returned invalid verification fields.');
  for (const item of draft.evidenceQuotes) {
    if (!isRecord(item) || typeof item.field !== 'string' || typeof item.value !== 'string' || typeof item.quote !== 'string') throw new Error('Planner returned an invalid evidence quote.');
    assertKeys(item, ['field', 'value', 'quote'], 'planner evidence quote');
  }
  const emailMentioned = /\be-?mails?\b/i.test(prompt);
  const emailModal = /\b(?:must|required|need|only)\b[^.]{0,60}\be-?mails?\b/i.test(prompt);
  if (draft.emailRequirement.requested && !emailMentioned) throw new Error('Planner invented an email requirement.');
  if (draft.emailRequirement.verified && !/verified\s+(?:decision[- ]makers?\s+|person(?:'s)?\s+)?e-?mails?|e-?mails?\s+(?:must be\s+)?verified/i.test(prompt)) throw new Error('Planner invented email verification intent.');
  if (draft.emailRequirement.required && !draft.emailRequirement.requested) throw new Error('Planner marked an unrequested email as required.');
  if (draft.emailRequirement.required && !draft.emailRequirement.verified && !emailModal) throw new Error('Planner made a plain email request mandatory.');
  if (draft.websiteRequirement.requested && !/website/i.test(prompt)) throw new Error('Planner invented a website requirement.');
  if (draft.websiteRequirement.required && !draft.websiteRequirement.requested) throw new Error('Planner marked an unrequested website as required.');
  if (draft.websiteRequirement.required && !/\b(?:must|required|need|only|with|including|and)\b[^.]{0,120}\b(?:company\s+)?website\b/i.test(prompt)) throw new Error('Planner made a plain website request mandatory.');
  if (draft.verificationRequirement.requested && !/\bverified\b|\bverification\b/i.test(prompt)) throw new Error('Planner invented a verification requirement.');
  if (draft.verificationRequirement.requested && verificationIntentNegated(prompt)) throw new Error('Planner enabled verification despite an explicit negation.');
  if (draft.verificationRequirement.required && !draft.verificationRequirement.requested) throw new Error('Planner marked verification as required without a request.');
  if (draft.emailRequirement.verified && verificationIntentNegated(prompt)) throw new Error('Planner enabled email verification despite an explicit negation.');
  if (draft.verificationRequirement.fields.some((field) => !fieldMentioned(prompt, field))) throw new Error('Planner assigned verification to an unrequested field.');
  assertFallbackCoverage(draft, fallback);
  if (draft.minimumScore != null) {
    if (!Number.isInteger(draft.minimumScore) || draft.minimumScore < 0 || draft.minimumScore > 100) throw new Error('Planner returned an invalid minimum score.');
    requireGrounded(draft, 'minimumScore', String(draft.minimumScore), prompt, (quote) => /score/i.test(quote) && new RegExp(`\\b${draft.minimumScore}\\b`).test(quote));
  }
  return draft;
}

function assertFallbackCoverage(draft: PlannerDraft, fallback: SearchPlan) {
  if (fallback.countIntent && draft.countIntent !== fallback.countIntent) throw new Error('Planner changed the explicit count intent.');
  if (fallback.targetType === 'QUALIFIED_LEADS' && draft.targetType !== 'QUALIFIED_LEADS') throw new Error('Planner dropped the qualified-lead target.');
  for (const expected of fallback.industry) {
    if (draft.industry.length === 0) continue;
    if (!draft.industry.some((actual) => categoryCovers(actual, expected))) throw new Error(`Planner omitted a recognized category (${expected}).`);
  }
  for (const expected of fallback.leadTypes) {
    if (draft.leadTypes.length === 0) continue;
    if (!draft.leadTypes.some((actual) => categoryCovers(actual, expected))) throw new Error(`Planner omitted a recognized lead type (${expected}).`);
  }
  for (const expected of fallback.locations) {
    const terms = [expected.originalText, expected.city, expected.state, expected.region, expected.country].filter((item): item is string => Boolean(item));
    if (!draft.locations.some((actual) => terms.some((term) => includesNormalized(actual.rawText, term)))) throw new Error('Planner omitted a recognized location.');
  }
  if (fallback.companySize) {
    const expected = fallback.companySize;
    const actual = draft.employeeSize;
    if (!actual || (expected.exact != null && actual.exact !== expected.exact)
      || (expected.min != null && actual.min !== expected.min)
      || (expected.max != null && actual.max !== expected.max)) throw new Error('Planner omitted or changed a numeric employee-size requirement.');
  }
  if (fallback.employeeSize?.qualitative && draft.employeeSize?.qualitative?.toLowerCase() !== fallback.employeeSize.qualitative.toLowerCase()) {
    throw new Error('Planner omitted a qualitative employee-size request.');
  }
  for (const expected of fallback.decisionMakerRoles ?? fallback.requiredRoles ?? []) {
    if (!draft.decisionMakerRoles.some((actual) => roleMentioned(actual, expected))) throw new Error(`Planner omitted a requested role (${expected}).`);
  }
  for (const expected of fallback.socialPlatforms ?? []) {
    if (!draft.socialPlatforms.includes(expected)) throw new Error(`Planner omitted a requested social platform (${expected}).`);
  }
  for (const expected of fallback.requiredFields ?? []) {
    const aliases: Record<string, string[]> = {
      website: ['website', 'companyWebsite'],
      email: ['email', 'companyEmail', 'personEmail'],
      phone: ['phone', 'companyPhone', 'personPhone'],
      linkedin: ['linkedin', 'personLinkedin', 'companyLinkedin'],
      facebook: ['facebook', 'personFacebook', 'companyFacebook'],
      instagram: ['instagram', 'personInstagram', 'companyInstagram'],
      companyLinkedin: ['companyLinkedin', 'linkedin'],
      companyFacebook: ['companyFacebook', 'facebook'],
      companyInstagram: ['companyInstagram', 'instagram'],
      companyYoutube: ['companyYoutube', 'youtube'],
      companyX: ['companyX', 'x', 'twitter'],
      personLinkedin: ['personLinkedin', 'linkedin'],
      personFacebook: ['personFacebook', 'facebook'],
      personInstagram: ['personInstagram', 'instagram'],
      personEmail: ['personEmail', 'email'],
    };
    const candidates = aliases[expected] ?? [expected];
    if (![...draft.requiredFields, ...draft.preferredFields, ...draft.companyFields, ...draft.personFields].some((field) => candidates.includes(field))) {
      throw new Error(`Planner omitted a requested field (${expected}).`);
    }
  }
  if (fallback.emailRequirement?.verified && !draft.emailRequirement.verified) throw new Error('Planner omitted the verified-email requirement.');
  if (fallback.emailRequirement?.required && !draft.emailRequirement.required) throw new Error('Planner omitted the required-email request.');
  if (fallback.websiteRequirement?.required && !draft.websiteRequirement.required) throw new Error('Planner omitted the required-website request.');
  if (fallback.minimumScore != null && draft.minimumScore !== fallback.minimumScore) throw new Error('Planner omitted the minimum score.');
}

function normalizeDraft(draft: PlannerDraft, prompt: string, fallback: SearchPlan): SearchPlan {
  const numericSize = normalizeSize(draft.employeeSize);
  const roles = unique([
    ...draft.decisionMakerRoles.map(canonicalizeRole),
    ...(fallback.decisionMakerRoles ?? fallback.requiredRoles ?? []).map(canonicalizeRole),
  ]);
  const requiredFields = unique([...draft.requiredFields, ...(fallback.requiredFields ?? [])]);
  const preferredFields = unique([...draft.preferredFields, ...(fallback.preferredFields ?? fallback.optionalFields ?? [])]).filter((field) => !requiredFields.includes(field));
  const legacyField = (field: string) => field === 'companyWebsite' ? 'website' : field;
  const legacyRequired = unique([...requiredFields.map(legacyField), ...(fallback.requiredFields ?? [])]);
  const legacyPreferred = unique([...preferredFields.map(legacyField), ...(fallback.optionalFields ?? [])]).filter((field) => !legacyRequired.includes(field));
  const locations = draft.locations.map(normalizeLocation);
  const unresolved = mergeUnresolved(
    draft.unresolvedRequirements.map(({ text, reason }) => ({ text, reason })),
    fallback.unresolvedRequirements ?? fallback.unresolvedCriteria,
    locations.filter((location) => !location.country).map((location) => ({ text: location.originalText ?? location.city ?? '', reason: 'location context is incomplete; no country was inferred' })),
    locations.filter((location) => /\b(?:near|around|within)\b/i.test(location.originalText ?? '') && !/\b\d+\s*(?:mi|miles?|km|kilometers?)\b/i.test(location.originalText ?? '')).map((location) => ({ text: location.originalText ?? '', reason: 'no search radius was specified' })),
  );
  const count = draft.requestedCount ?? fallback.requestedCount;
  const intent = draft.countIntent ?? fallback.countIntent ?? (count == null ? undefined : 'exact');
  const industry = unique([
    ...draft.industry.map((item) => {
      const match = fallback.industry.find((expected) => categoryCovers(item, expected));
      return normalizeTerm(match ?? item);
    }),
    ...(draft.industry.length ? [] : fallback.industry.map(normalizeTerm)),
  ]);
  const leadTypes = unique([
    ...draft.leadTypes.map((item) => {
      const match = fallback.leadTypes.find((expected) => categoryCovers(item, expected));
      return normalizeTerm(match ?? item);
    }),
    ...(draft.leadTypes.length ? [] : fallback.leadTypes.map(normalizeTerm)),
  ]);
  const personFields = unique([...draft.personFields, ...(fallback.personFields ?? [])]);
  const companyFields = unique([...draft.companyFields, ...(fallback.companyFields ?? [])]);
  const socialPlatforms = unique([...draft.socialPlatforms, ...(fallback.socialPlatforms ?? [])]);
  const companySize = numericSize ?? fallback.companySize;
  const employeeSize = draft.employeeSize
    ? { ...numericSize, ...(draft.employeeSize.qualitative ? { qualitative: draft.employeeSize.qualitative } : {}) }
    : fallback.employeeSize ?? companySize;
  const unresolvedCriteria = unresolved;
  return {
    targetType: draft.targetType,
    industry,
    ...(industry[0] ? { category: industry[0] } : {}),
    leadTypes,
    locations: locations.length ? locations : fallback.locations,
    ...(companySize ? { companySize, employeeRange: companySize } : {}),
    ...(employeeSize ? { employeeSize } : {}),
    companyFields,
    personFields,
    socialPlatforms,
    contactRequirements: roles.length || personFields.length ? { titles: roles, fields: unique(['name', ...personFields]) } : undefined,
    requiredRoles: roles,
    decisionMakerRoles: roles,
    requiredFields: legacyRequired,
    optionalFields: legacyPreferred,
    preferredFields,
    emailRequirement: verificationIntentNegated(prompt)
      ? { ...draft.emailRequirement, verified: false }
      : draft.emailRequirement,
    websiteRequirement: draft.websiteRequirement,
    verificationRequirement: verificationIntentNegated(prompt)
      ? { requested: false, required: false, fields: [] }
      : draft.verificationRequirement,
    ...(draft.minimumScore != null ? { minimumScore: draft.minimumScore } : {}),
    ...(count != null ? { requestedCount: count, maxResults: Math.min(RESULT_SAFETY_CAP, count), countIntent: intent } : {}),
    ...(fallback.exclusions && { exclusions: fallback.exclusions }),
    searchIntent: fallback.searchIntent,
    unresolvedCriteria,
    unresolvedRequirements: unresolved,
    originalPrompt: prompt.trim(),
  };
}

function normalizeSize(size: PlannerDraft['employeeSize']): CompanySize | undefined {
  if (!size) return undefined;
  if (size.exact != null) return { exact: size.exact, min: size.exact, max: size.exact };
  if (size.min != null || size.max != null) return { ...(size.min != null ? { min: size.min } : {}), ...(size.max != null ? { max: size.max } : {}) };
  return undefined;
}

function normalizeLocation(location: PlannerDraft['locations'][number]): SearchLocation {
  const normalized = interpretPlace(location.rawText);
  const country = normalized.country || location.country || undefined;
  const state = normalized.state || location.state || undefined;
  const city = normalized.city || location.city || undefined;
  const region = normalized.region || location.region || undefined;
  return {
    ...(country ? { country } : {}),
    ...(state ? { state } : {}),
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(location.postalCode ? { postalCode: location.postalCode } : {}),
    originalText: location.rawText,
  };
}

function requireGrounded(draft: PlannerDraft, field: string, value: string, prompt: string, supported: (quote: string) => boolean) {
  const quote = quoteFor(draft, field, value);
  if (!quote || !includesNormalized(prompt, quote) || !supported(quote)) throw new Error(`Planner requirement is not grounded in the prompt (${field}: ${value}).`);
}

function quoteFor(draft: PlannerDraft, field: string, value: string): string {
  return draft.evidenceQuotes.find((item) => item.field === field && item.value.toLowerCase() === value.toLowerCase())?.quote ?? '';
}

function quoteForFlexible(draft: PlannerDraft, field: string, value: string): string {
  return draft.evidenceQuotes.find((item) => {
    if (item.field !== field) return false;
    return item.value.toLowerCase() === value.toLowerCase()
      || includesNormalized(item.value, value)
      || includesNormalized(value, item.value)
      || includesNormalized(item.quote, value.replace(/_/g, ' '));
  })?.quote ?? '';
}

function quoteForLocation(draft: PlannerDraft, rawText: string): string {
  return draft.evidenceQuotes.find((item) => {
    if (item.field !== 'locations' && item.field !== 'location') return false;
    return item.value.toLowerCase() === rawText.toLowerCase()
      || includesNormalized(item.value, rawText)
      || includesNormalized(rawText, item.value)
      || includesNormalized(item.quote, rawText);
  })?.quote ?? '';
}

function phraseGroundedInPrompt(prompt: string, value: string): boolean {
  return hasPhrase(prompt, value) || includesNormalized(prompt, value.replace(/_/g, ' '));
}

function categoryCovers(actual: string, expected: string): boolean {
  if (normalizeTerm(actual) === normalizeTerm(expected)) return true;
  if (hasPhrase(actual.replace(/_/g, ' '), expected) || hasPhrase(expected.replace(/_/g, ' '), actual)) return true;
  if (expected === 'real_estate' && /real[ _-]?estate/i.test(actual)) return true;
  if (expected === 'real_estate_investor' && /real[ _-]?estate/i.test(actual) && /invest|acquisition|buyer/i.test(actual)) return true;
  return false;
}

function hasPhrase(text: string, value: string): boolean {
  const tokens = value.replace(/_/g, ' ').toLowerCase().split(/\s+/).filter(Boolean).map(singularize);
  const sourceTokens = text.toLowerCase().match(/[a-z0-9]+/g)?.map(singularize) ?? [];
  if (!tokens.length) return false;
  return sourceTokens.some((_, start) => tokens.every((token, offset) => sourceTokens[start + offset] === token));
}

function roleMentioned(text: string, role: string): boolean {
  return hasPhrase(text, role)
    || (role.toLowerCase() === 'ceo' && /chief executive officer|\bceos?\b/i.test(text))
    || (/^co-?founders?$/i.test(role) && /co-?founders?/i.test(text))
    || (/^founders?$/i.test(role) && /co-?founders?|\bfounders?\b/i.test(text))
    || (/^owners?$/i.test(role) && /\bowners?\b/i.test(text))
    || (/^managers?$/i.test(role) && /\bmanagers?\b/i.test(text))
    || (/^partners?$/i.test(role) && /\bpartners?\b/i.test(text))
    || (role.toLowerCase() === 'x' && /twitter/i.test(text));
}

function canonicalizeRole(role: string): string {
  const normalized = role.trim().toLowerCase().replace(/_/g, ' ');
  if (/^ceos?$|chief executive officer/.test(normalized)) return 'CEO';
  if (/^co-?founders?$/.test(normalized)) return 'Co-Founder';
  if (/^founders?$/.test(normalized)) return 'Founder';
  if (/^presidents?$/.test(normalized)) return 'President';
  if (/^owners?$/.test(normalized)) return 'Owner';
  if (/^managing directors?$/.test(normalized)) return 'Managing Director';
  if (/^managers?$/.test(normalized)) return 'Manager';
  if (/^partners?$/.test(normalized)) return 'Partner';
  return role.trim().replace(/\b\w/g, (char) => char.toUpperCase());
}

function countMentioned(text: string, count: number): boolean {
  return new RegExp(`(?:\\b(?:find|get|show|need|want|search(?:\\s+for)?|looking\\s+for|up to|at least|maximum(?: of)?|max|around|about|approximately|approx)\\s+${count}\\b|\\b${count}\\s+(?:companies|company|leads|lead|agencies|agency|firms|firm|businesses|business|restaurants|restaurant)\\b)`, 'i').test(text);
}

function locationComponentAllowed(
  component: 'country' | 'state' | 'city' | 'region' | 'postalCode',
  part: string,
  rawText: string,
  known: SearchLocation,
): boolean {
  if (includesNormalized(rawText, part)) return true;
  const knownValue = known[component];
  if (knownValue && (includesNormalized(knownValue, part) || normalizeTerm(knownValue) === normalizeTerm(part))) return true;
  if (component === 'country' && known.country) {
    const resolved = interpretPlace(part).country;
    if (resolved && normalizeTerm(resolved) === normalizeTerm(known.country)) return true;
  }
  if (component === 'state' && known.state) {
    const resolved = interpretPlace(part);
    if (resolved.state && normalizeTerm(resolved.state) === normalizeTerm(known.state)) return true;
  }
  return false;
}

function fieldMentioned(text: string, field: string): boolean {
  const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases: Record<string, RegExp> = {
    companywebsite: /website|web site/i, companyemail: /company(?:'s)?\s+e-?mail/i, companyphone: /company(?:'s)?\s+phone/i,
    companylinkedin: /company\s+linkedin|linkedin/i, companyfacebook: /company\s+facebook|facebook/i,
    companyinstagram: /company\s+instagram|instagram/i, companyyoutube: /company\s+youtube|youtube/i,
    companyx: /company\s+(?:x|twitter)|(?:x\/twitter|twitter|x account)/i,
    employeecount: /employee|staff|headcount|company size/i, location: /location|address|city|state|country|region|postal code|zip/i,
    industry: /industry|category/i, personname: /name|ceo|founder|owner|president|manager|partner/i,
    persontitle: /title|role|ceo|founder|owner|president|manager|partner/i,
    personemail: /person(?:'s)?\s+e-?mail|decision[- ]maker(?:'s)?\s+e-?mail|contact e-?mail|verified\s+(?:person(?:'s)?\s+|decision[- ]makers?\s+)?e-?mails?/i,
    personphone: /person(?:'s)?\s+phone|decision[- ]maker(?:'s)?\s+phone|contact phone/i,
    personlinkedin: /(?:their|person(?:'s)?|decision[- ]maker(?:'s)?|ceo(?:'s)?|founder(?:'s)?)\s+linkedin|linkedin/i,
    personfacebook: /(?:their|person(?:'s)?)\s+facebook|facebook/i,
    personinstagram: /(?:their|person(?:'s)?)\s+instagram|instagram/i,
    personyoutube: /(?:their|person(?:'s)?)\s+youtube|youtube/i,
    personx: /(?:their|person(?:'s)?)\s+(?:x|twitter)|(?:x\/twitter|twitter)/i,
    email: /e-?mail/i, phone: /phone/i, linkedin: /linkedin/i, facebook: /facebook/i, instagram: /instagram/i,
    x: /x\/twitter|twitter|x account/i, youtube: /youtube/i, website: /website|web site/i,
  };
  return aliases[normalized]?.test(text) ?? new RegExp(`\\b${escapeRegExp(field)}\\b`, 'i').test(text);
}

function includesNormalized(text: string, value: string): boolean {
  return normalizeText(text).includes(normalizeText(value));
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeTerm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function mergeUnresolved(...groups: UnresolvedCriterion[][]): UnresolvedCriterion[] {
  const seen = new Set<string>();
  return groups.flat().filter((item) => {
    const key = `${normalizeText(item.text)}|${normalizeText(item.reason)}`;
    if (!item.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function singularize(value: string): string {
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'AI planner failed.';
  return raw.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, '$1[REDACTED]').slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Planner returned unsupported properties in ${label}.`);
}

function nullable(schema: Record<string, unknown>) {
  return { anyOf: [schema, { type: 'null' }] };
}

function stringArray() { return { type: 'array', items: { type: 'string' } }; }

function enumArray(values: readonly string[]) { return { type: 'array', items: { type: 'string', enum: [...values] } }; }

function strictObject(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }