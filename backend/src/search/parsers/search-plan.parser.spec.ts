import { SearchPlanParser } from './search-plan.parser';

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

  it('does not invent criteria for an unsupported prompt', () => {
    const plan = parser.parse('Find excellent businesses with strong reputations.');
    expect(plan.industry).toEqual([]);
    expect(plan.leadTypes).toEqual([]);
    expect(plan.unresolvedCriteria[0]?.reason).toContain('no supported');
  });
});
