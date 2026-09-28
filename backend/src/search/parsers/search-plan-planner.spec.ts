import { ConfigService } from '@nestjs/config';
import { UsageService } from '../../usage/usage.service';
import { discoveryTarget } from '../search-plan.limits';
import { SearchPlanParser } from './search-plan.parser';
import { SearchPlanPlanner } from './search-plan-planner';

function draftFor(prompt: string, overrides: Record<string, unknown> = {}) {
  const parsed = new SearchPlanParser().parse(prompt);
  const count = parsed.requestedCount ?? null;
  const locationText = (location: SearchPlanParserLocation) => location.originalText ?? location.city ?? location.state ?? location.region ?? location.country ?? '';
  const locations = parsed.locations.map((location) => ({
    rawText: locationText(location),
    country: location.country ?? null,
    state: location.state ?? null,
    city: location.city ?? null,
    region: location.region ?? null,
    postalCode: location.postalCode ?? null,
  }));
  const sizeMatch = prompt.match(/\b\d+\s*(?:to|-|–)\s*\d+\s*employees?\b|\b\d+\s*\+\s*employees?\b|\b\d+\s+employees?\b|\b(?:small|medium-sized|mid-sized|midmarket|large)\s+(?:companies|businesses|firms)\b/i);
  const employeeSize = parsed.employeeSize ? {
    min: parsed.employeeSize.min ?? null,
    max: parsed.employeeSize.max ?? null,
    exact: parsed.employeeSize.exact ?? null,
    qualitative: parsed.employeeSize.qualitative ?? null,
    sourceText: sizeMatch?.[0] ?? '',
  } : null;
  const emailVerified = /verified\s+e-?mail|e-?mail\s+(?:must be\s+)?verified/i.test(prompt);
  const emailRequested = /e-?mail/i.test(prompt);
  const websiteRequested = /website/i.test(prompt);
  const roleNames = parsed.decisionMakerRoles ?? [];
  const base = {
    requestedCount: count,
    countIntent: parsed.countIntent ?? (count == null ? null : 'exact'),
    targetType: parsed.targetType ?? 'COMPANIES',
    industry: parsed.industry,
    leadTypes: parsed.leadTypes,
    locations,
    employeeSize,
    decisionMakerRoles: roleNames,
    requiredFields: parsed.requiredFields ?? [],
    preferredFields: parsed.preferredFields ?? [],
    companyFields: [],
    personFields: [],
    socialPlatforms: parsed.socialPlatforms ?? [],
    emailRequirement: { requested: emailRequested, required: emailVerified || (emailRequested && /\b(?:must|required|need|only)\b[^.]{0,40}\be-?mail\b/i.test(prompt)), verified: emailVerified },
    websiteRequirement: { requested: websiteRequested, required: websiteRequested && /\b(?:must|required|need|only)\b[^.]{0,40}\bwebsite\b/i.test(prompt) },
    verificationRequirement: { requested: emailVerified, required: emailVerified, fields: emailVerified ? ['email'] : [] },
    minimumScore: parsed.minimumScore ?? null,
    unresolvedRequirements: (parsed.unresolvedRequirements ?? []).map((item) => ({ ...item, sourceText: prompt })),
  };
  const draft = { ...base, ...overrides } as Record<string, any>;
  const evidenceQuotes: Array<{ field: string; value: string; quote: string }> = [];
  if (draft.requestedCount != null) evidenceQuotes.push({ field: 'requestedCount', value: String(draft.requestedCount), quote: prompt });
  for (const value of draft.industry) evidenceQuotes.push({ field: 'industry', value, quote: prompt });
  for (const value of draft.leadTypes) evidenceQuotes.push({ field: 'leadTypes', value, quote: prompt });
  for (const location of draft.locations) evidenceQuotes.push({ field: 'locations', value: location.rawText, quote: prompt });
  for (const value of draft.decisionMakerRoles) evidenceQuotes.push({ field: 'decisionMakerRoles', value, quote: prompt });
  for (const value of [...draft.requiredFields, ...draft.preferredFields, ...draft.companyFields, ...draft.personFields]) evidenceQuotes.push({ field: 'fields', value, quote: prompt });
  for (const value of draft.socialPlatforms) evidenceQuotes.push({ field: 'socialPlatforms', value, quote: prompt });
  if (draft.minimumScore != null) evidenceQuotes.push({ field: 'minimumScore', value: String(draft.minimumScore), quote: prompt });
  return { ...draft, evidenceQuotes };
}

type SearchPlanParserLocation = ReturnType<SearchPlanParser['parse']>['locations'][number];

function setup(prompt: string, response?: unknown, rejection?: Error) {
  const parser = new SearchPlanParser();
  const openRouter = { completeJson: jest.fn().mockImplementation(() => rejection ? Promise.reject(rejection) : Promise.resolve(response ?? draftFor(prompt))) };
  const config = { get: jest.fn((key: string) => key === 'openRouter.model' ? 'test/model' : undefined) };
  const usage = {
    checkRequestRate: jest.fn().mockResolvedValue(undefined),
    assertDailyQuota: jest.fn().mockResolvedValue(undefined),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  return { planner: new SearchPlanPlanner(openRouter as never, parser, config as unknown as ConfigService, usage as unknown as UsageService), openRouter, usage, parser };
}

describe('SearchPlanPlanner', () => {
  it.each([
    ['Find 50 software companies in California', { requestedCount: 50, industry: ['software'], locations: [{ state: 'California', country: 'US' }] }],
    ['Find 300 marketing agencies in New York', { requestedCount: 300, industry: ['marketing'], locations: [{ state: 'New York', country: 'US' }] }],
    ['Find 200 SaaS companies in Germany', { requestedCount: 200, industry: ['saas'], locations: [{ country: 'Germany' }] }],
    ['Find 100 restaurants in Dubai', { requestedCount: 100, industry: ['restaurant'], locations: [{ city: 'Dubai', country: 'United Arab Emirates' }] }],
    ['Find 150 construction companies in Florida with 10-100 employees', { requestedCount: 150, industry: ['construction'], companySize: { min: 10, max: 100 }, locations: [{ state: 'Florida', country: 'US' }] }],
    ['Find 200 real estate investment companies in Texas with founders or CEOs', { requestedCount: 200, industry: ['real_estate'], leadTypes: ['real_estate_investor'], decisionMakerRoles: ['CEO', 'Founder'] }],
    ['Find 100 cybersecurity companies in Pakistan', { requestedCount: 100, industry: ['cybersecurity'], locations: [{ country: 'Pakistan' }] }],
    ['Find 50 companies in Lahore', { requestedCount: 50, industry: [], locations: [{ city: 'Lahore', country: 'Pakistan' }] }],
    ['Find 200 qualified leads without specifying employee size', { requestedCount: 200, targetType: 'QUALIFIED_LEADS' }],
    ['Find 200 companies without specifying an industry', { requestedCount: 200, industry: [] }],
    ['Find small companies', { employeeSize: { qualitative: 'small' } }],
    ['Find software companies and identify the CEO or founder', { decisionMakerRoles: ['CEO', 'Founder'] }],
    ['Find companies with LinkedIn and Facebook', { socialPlatforms: ['linkedin', 'facebook'] }],
    ['Find companies with verified email', { emailRequirement: { requested: true, required: true, verified: true } }],
    ['Find companies with email', { emailRequirement: { requested: true, required: false, verified: false } }],
    ['Find investment companies in Texas', { leadTypes: [], industry: ['investment'] }],
    ['Find companies in Bavaria', { locations: [{ city: 'Bavaria', originalText: 'Bavaria' }] }],
    ['Find around 200 logistics companies in Toronto', { requestedCount: 200, countIntent: 'approximate', industry: ['logistic'] }],
  ])('plans %s from the returned structured response', async (prompt, expected) => {
    const { planner } = setup(prompt);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.planning).toEqual({ method: 'ai', model: 'test/model' });
    expect(plan).toMatchObject(expected);
    expect(plan.originalPrompt).toBe(prompt);
  });

  it('preserves a numeric employee request but leaves qualitative size non-numeric', async () => {
    const prompt = 'Find small companies';
    const response = draftFor(prompt, { employeeSize: { min: 1, max: 50, exact: null, qualitative: 'small', sourceText: prompt } });
    const { planner } = setup(prompt, response);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.companySize).toBeUndefined();
    expect(plan.employeeSize).toMatchObject({ qualitative: 'small' });
    expect(plan.planning?.method).toBe('deterministic_fallback');
  });

  it.each([
    ['invalid JSON', new Error('OpenRouter returned a malformed classification response')],
    ['a timeout', new Error('OpenRouter request timed out after 20000ms')],
    ['a provider failure', new Error('OpenRouter provider temporarily unavailable')],
  ])('uses deterministic fallback after %s', async (_label, error) => {
    const prompt = 'Find 50 software companies in California';
    const { planner } = setup(prompt, undefined, error);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan).toMatchObject({ requestedCount: 50, industry: ['software'], planning: { method: 'deterministic_fallback' } });
    expect(plan.planning?.error).toBeTruthy();
  });

  it('falls back when model criteria lack prompt evidence', async () => {
    const prompt = 'Find 20 software companies in Lahore';
    const response = draftFor(prompt, { industry: ['construction'] });
    const { planner } = setup(prompt, response);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.planning?.method).toBe('deterministic_fallback');
    expect(plan.industry).toEqual(['software']);
  });

  it('does not infer a numeric count from an employee count or invent target type', async () => {
    const prompt = 'Find software companies with 25 employees';
    const response = draftFor(prompt, { requestedCount: 25, targetType: 'QUALIFIED_LEADS' });
    const { planner } = setup(prompt, response);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.planning?.method).toBe('deterministic_fallback');
    expect(plan.targetType).toBe('COMPANIES');
    expect(plan.requestedCount).toBeUndefined();
  });

  it.each([
    ['a numeric size range', 'Find small companies', { employeeSize: { min: 1, max: 50, exact: null, qualitative: 'small', sourceText: 'small companies' } }],
    ['a country for an unresolved place', 'Find software companies in Jupiter', { locations: [{ rawText: 'Jupiter', country: 'US', state: null, city: 'Jupiter', region: null, postalCode: null }] }],
    ['a social platform omitted by the model', 'Find companies with LinkedIn and Facebook', { socialPlatforms: ['linkedin'] }],
  ])('falls back rather than accepting an invented or omitted %s', async (_label, prompt, overrides) => {
    const { planner } = setup(prompt, draftFor(prompt, overrides));
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.planning?.method).toBe('deterministic_fallback');
  });

  it('falls back when the model returns properties outside the strict plan schema', async () => {
    const prompt = 'Find 5 software companies in California';
    const response = { ...draftFor(prompt), guessedRadius: 25 };
    const { planner } = setup(prompt, response);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.planning?.method).toBe('deterministic_fallback');
  });

  it('keeps the explicit count separate from the qualified-lead target and preserves the no-count default', async () => {
    const qualifiedPrompt = 'Find 200 qualified leads';
    const qualified = await setup(qualifiedPrompt).planner.plan(qualifiedPrompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(qualified).toMatchObject({ requestedCount: 200, targetType: 'QUALIFIED_LEADS' });
    expect(discoveryTarget(qualified)).toBe(200);

    const noCountPrompt = 'Find software companies in California';
    const noCount = await setup(noCountPrompt).planner.plan(noCountPrompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(noCount.requestedCount).toBeUndefined();
    expect(discoveryTarget(noCount)).toBe(100);
  });

  it('accepts normalized country aliases that match the known place', async () => {
    const prompt = 'Find 5 software companies in California';
    const response = draftFor(prompt, {
      locations: [{ rawText: 'California', country: 'United States', state: 'California', city: null, region: null, postalCode: null }],
    });
    const { planner } = setup(prompt, response);
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(plan.planning?.method).toBe('ai');
    expect(plan.locations[0]).toMatchObject({ country: 'US', state: 'California' });
  });

  it('falls back when planner quota is unavailable and records planner observability in the plan', async () => {
    const prompt = 'Find 50 companies in Lahore';
    const { planner, usage, openRouter } = setup(prompt);
    usage.assertDailyQuota.mockRejectedValueOnce(new Error('AI_CLASSIFICATION_DAILY limit reached'));
    const plan = await planner.plan(prompt, { organizationId: 'org-1', userId: 'user-1' });
    expect(openRouter.completeJson).not.toHaveBeenCalled();
    expect(plan.planning).toMatchObject({ method: 'deterministic_fallback', model: 'test/model' });
    expect(plan.unresolvedRequirements).toEqual(expect.any(Array));
  });
});