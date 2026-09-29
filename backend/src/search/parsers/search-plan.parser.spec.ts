import { SearchPlanParser } from './search-plan.parser';
import { discoveryQueryBudget, discoveryTarget } from '../search-plan.limits';

describe('SearchPlanParser', () => {
  const parser = new SearchPlanParser();

  it('normalizes the requested real-estate search criteria', () => {
    const plan = parser.parse('Find real estate companies in TX that are cash home buyers with 1–50 employees. Need website, LinkedIn, Facebook and Instagram, plus the CEO, founder or president with email.');

    expect(plan).toMatchObject({
      industry: ['real_estate'],
      leadTypes: ['cash_home_buyer'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      companyFields: ['website', 'linkedin', 'facebook', 'instagram'],
      contactRequirements: {
        titles: ['CEO', 'Founder', 'President'],
        fields: ['name', 'email', 'linkedin', 'facebook', 'instagram'],
      },
    });
  });

  it('preserves unsupported evidence-dependent criteria as unresolved', () => {
    const plan = parser.parse('Find real estate investors actively buying distressed properties in Texas.');

    expect(plan.unresolvedCriteria).toContainEqual({
      text: 'actively buying distressed properties',
      reason: 'requires evidence-based source classification',
    });
  });

  it('reads company size and decision-maker roles from alternate phrasing', () => {
    const plan = parser.parse('Find cash home buyers in Texas with company size 1-50 and identify their CEO, founder, president, or owner.');
    expect(plan.leadTypes).toContain('cash_home_buyer');
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);
    expect(plan.companySize).toEqual({ min: 1, max: 50 });
    expect(plan.requiredRoles).toEqual(expect.arrayContaining(['CEO', 'Founder', 'President', 'Owner']));
  });

  it('parses the Texas investor acceptance prompt without inventing a full result set', () => {
    const plan = parser.parse('Find up to 50 real estate investment companies in Texas with company size 1-50 employees');
    expect(plan).toMatchObject({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      maxResults: 50,
    });
    expect(plan.requiredRoles).toBeUndefined();
  });

  it.each([
    'Find real estate investors in Texas',
    'Find real-estate investors in Texas',
    'Find real estate investment companies in Texas',
    'Find real-estate investment companies in Texas',
    'Find up to 50 real-estate investment companies in Texas with company size 1-50 employees',
  ])('normalizes %s into the real-estate investor plan', (prompt) => {
    const plan = parser.parse(prompt);
    expect(plan.industry).toEqual(['real_estate']);
    expect(plan.leadTypes).toEqual(['real_estate_investor']);
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);
  });

  it('keeps the requested 1-50 employee range without turning an agency into an investor', () => {
    const plan = parser.parse('Find up to 50 real-estate investment companies in Texas with company size 1-50 employees.');
    expect(plan.companySize).toEqual({ min: 1, max: 50 });
    expect(plan.maxResults).toBe(50);
    const agency = parser.parse('Find real-estate agents in Texas');
    expect(agency.industry).toEqual(['real_estate']);
    expect(agency.leadTypes).toEqual([]);
  });

  it('accepts the 500-company Texas real-estate investor prompt', () => {
    const plan = parser.parse('Find up to 500 real-estate investment companies in Texas with company size 1-50 employees.');
    expect(plan).toMatchObject({
      industry: ['real_estate'],
      leadTypes: ['real_estate_investor'],
      locations: [{ country: 'US', state: 'Texas' }],
      companySize: { min: 1, max: 50 },
      maxResults: 500,
    });
  });

  it.each([
    'real estate investment',
    'real-estate investment',
    'real estate investor',
    'real-estate investor',
    'property investor',
    'real estate investment company',
  ])('maps "%s" to a real-estate investor plan', (phrase) => {
    const plan = parser.parse(`Find up to 500 ${phrase} firms in Texas with company size 1-50 employees.`);
    expect(plan.leadTypes).toContain('real_estate_investor');
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);
    expect(plan.companySize).toEqual({ min: 1, max: 50 });
    expect(plan.maxResults).toBe(500);
    expect(plan.industry).toEqual(['real_estate']);
  });

  it('does not treat a generic investment company as a real-estate investor', () => {
    const plan = parser.parse('Find up to 500 investment company firms in Texas with company size 1-50 employees.');
    expect(plan.leadTypes).not.toContain('real_estate_investor');
    expect(plan.industry).toEqual(['investment']);
    expect(plan.locations).toEqual([{ country: 'US', state: 'Texas' }]);
    expect(plan.companySize).toEqual({ min: 1, max: 50 });
    expect(plan.requestedCount).toBe(500);
  });

  it.each([
    ['Find 50 real estate investment companies in Texas', { requestedCount: 50, countIntent: 'exact', industry: ['real_estate'], leadTypes: ['real_estate_investor'], locations: [{ country: 'US', state: 'Texas' }] }],
    ['Find 300 software companies in California', { requestedCount: 300, industry: ['software'], leadTypes: [], locations: [{ country: 'US', state: 'California' }] }],
    ['Find 100 marketing agencies in New York', { requestedCount: 100, industry: ['marketing'], leadTypes: [], locations: [{ country: 'US', state: 'New York' }] }],
    ['Find 200 SaaS companies in Germany', { requestedCount: 200, industry: ['saas'], leadTypes: [], locations: [{ country: 'Germany' }] }],
    ['Find 75 restaurants in Dubai', { requestedCount: 75, industry: ['restaurant'], leadTypes: [], locations: [{ city: 'Dubai', country: 'United Arab Emirates' }] }],
    ['Find 50 companies in Lahore', { requestedCount: 50, industry: [], leadTypes: [], locations: [{ city: 'Lahore', country: 'Pakistan' }] }],
    ['Find up to 500 companies', { requestedCount: 500, countIntent: 'maximum', industry: [], leadTypes: [], locations: [] }],
    ['Find 50 companies', { requestedCount: 50, industry: [], leadTypes: [], locations: [] }],
    ['Find 300 companies', { requestedCount: 300, industry: [], leadTypes: [], locations: [] }],
    ['Find at least 100 companies', { requestedCount: 100, countIntent: 'minimum', industry: [], leadTypes: [], locations: [] }],
    ['Find maximum 300 companies', { requestedCount: 300, countIntent: 'maximum', industry: [], leadTypes: [], locations: [] }],
  ])('parses %s', (prompt, expected) => {
    const plan = parser.parse(prompt);
    expect(plan).toMatchObject(expected);
    expect(plan.maxResults).toBe(expected.requestedCount);
    expect(plan.companySize).toBeUndefined();
  });

  it('keeps an employee range only when the prompt states one', () => {
    const sized = parser.parse('Find 150 construction companies in Florida with 10-100 employees');
    expect(sized).toMatchObject({
      requestedCount: 150,
      industry: ['construction'],
      locations: [{ country: 'US', state: 'Florida' }],
      companySize: { min: 10, max: 100 },
      employeeRange: { min: 10, max: 100 },
    });
    const open = parser.parse('Find 300 leads without specifying company size');
    expect(open.requestedCount).toBe(300);
    expect(open.companySize).toBeUndefined();
    expect(open.employeeRange).toBeUndefined();
    expect(open.industry).toEqual([]);
    expect(open.locations).toEqual([]);
  });

  it('preserves qualified-lead target and approximate count intent', () => {
    const qualified = parser.parse('Find 200 qualified leads without specifying employee size');
    expect(qualified).toMatchObject({ requestedCount: 200, targetType: 'QUALIFIED_LEADS' });
    expect(qualified.employeeSize).toBeUndefined();
    const approximate = parser.parse('Find around 200 logistics companies in Toronto');
    expect(approximate).toMatchObject({ requestedCount: 200, countIntent: 'approximate' });
    expect(approximate.locations[0]?.originalText).toBeUndefined();
  });

  it('keeps qualitative size unresolved instead of inventing numeric bounds', () => {
    const plan = parser.parse('Find small companies');
    expect(plan.companySize).toBeUndefined();
    expect(plan.employeeSize).toEqual({ qualitative: 'small' });
    expect(plan.unresolvedRequirements).toContainEqual(expect.objectContaining({
      text: 'small',
      reason: 'qualitative employee size was requested without a numeric range',
    }));
  });

  it('does not invent a radius for relative locations', () => {
    const plan = parser.parse('Find companies near London');
    expect(plan.locations).toEqual([{ city: 'London', country: 'United Kingdom' }]);
    expect(plan.unresolvedRequirements).toContainEqual({ text: 'near London', reason: 'no search radius was specified' });
  });

  it('distinguishes verified email from plain email and preserves multiple social requests', () => {
    const verified = parser.parse('Find companies with verified email');
    const plain = parser.parse('Find companies with email');
    expect(verified.emailRequirement).toEqual({ requested: true, required: true, verified: true });
    expect(plain.emailRequirement).toEqual({ requested: true, required: false, verified: false });

    const socials = parser.parse('Find companies with LinkedIn and Facebook');
    expect(socials.socialPlatforms).toEqual(['linkedin', 'facebook']);
    expect(socials.personFields).toEqual(expect.arrayContaining(['linkedin', 'facebook']));
  });

  it('extracts partner alongside other decision-maker roles', () => {
    const plan = parser.parse('Find consulting firms and identify the partner or managing director');
    expect(plan.decisionMakerRoles).toEqual(expect.arrayContaining(['Partner', 'Managing Director']));
  });

  it('keeps unknown location text in the plan and marks its missing context', () => {
    const plan = parser.parse('Find 50 companies in Bavaria');
    expect(plan.locations[0]).toMatchObject({ city: 'Bavaria', originalText: 'Bavaria' });
    expect(plan.unresolvedRequirements).toContainEqual(expect.objectContaining({
      text: 'Bavaria',
      reason: 'location could not be confidently resolved to a country or administrative area',
    }));
  });

  it('accepts a place outside the old state list', () => {
    const plan = parser.parse('Find 20 bakeries in Bavaria');
    expect(plan.requestedCount).toBe(20);
    expect(plan.industry).toEqual(['bakery']);
    expect(plan.locations[0]?.city).toBe('Bavaria');
    expect(plan.leadTypes).toEqual([]);
  });

  it('does not invent criteria for an unsupported prompt', () => {
    const plan = parser.parse('Find excellent businesses with strong reputations.');
    expect(plan.industry).toEqual([]);
    expect(plan.leadTypes).toEqual([]);
    expect(plan.unresolvedCriteria[0]?.reason).toContain('no supported');
  });

  it('keeps an explicit count instead of the default and scales the web query budget', () => {
    expect(discoveryTarget(parser.parse('Find 50 companies'))).toBe(50);
    expect(discoveryTarget(parser.parse('Find 300 companies'))).toBe(300);
    expect(discoveryTarget(parser.parse('Find 500 companies'))).toBe(500);
    expect(discoveryTarget(parser.parse('Find companies in Ohio'))).toBe(100);
    expect(discoveryQueryBudget(50)).toBe(25);
    expect(discoveryQueryBudget(300)).toBe(150);
    expect(discoveryQueryBudget(500)).toBe(240);
  });

  it('Phase C: expands generic social profile wording to supported company platforms', () => {
    const plan = parser.parse('Find 10 software companies in California with social profiles');
    expect(plan.socialPlatforms).toEqual(expect.arrayContaining(['linkedin', 'facebook', 'instagram', 'youtube', 'x']));
    expect(plan.industry).toEqual(['software']);
    expect(plan.locations).toEqual([{ country: 'US', state: 'California' }]);
  });

  it('Phase C: treats verified decision-maker emails as person email intent', () => {
    const plan = parser.parse('Find 10 software companies in California with verified decision-maker emails');
    expect(plan.emailRequirement).toEqual({ requested: true, required: true, verified: true });
    expect(plan.personFields).toContain('email');
    expect(plan.verificationRequirement?.fields).toContain('email');
  });

  it('Phase C: keeps investor prompts with founders/CEOs and verified emails', () => {
    const plan = parser.parse('Find 10 real estate investment companies in Texas with founders or CEOs and verified emails');
    expect(plan.leadTypes).toContain('real_estate_investor');
    expect(plan.decisionMakerRoles).toEqual(expect.arrayContaining(['Founder', 'CEO']));
    expect(plan.emailRequirement?.verified).toBe(true);
    expect(plan.emailRequirement?.required).toBe(true);
  });
});
