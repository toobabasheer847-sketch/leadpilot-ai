import { employeeSizeRequested } from '../search/search-plan.limits';
import { prioritizeCompanyPages } from './website/website-discovery.service';
import { classifyOfficialWebsiteHost, evaluateOfficialWebsite } from './website/official-website.validator';
import { publicCompanyProfiles } from './social/company-social-discovery.service';

describe('Phase C plan-driven enrichment', () => {
  it('rejects social, directory, job-board, and news hosts as official websites', () => {
    expect(classifyOfficialWebsiteHost('linkedin.com')).toBe('SOCIAL_PROFILE');
    expect(classifyOfficialWebsiteHost('facebook.com')).toBe('SOCIAL_PROFILE');
    expect(classifyOfficialWebsiteHost('instagram.com')).toBe('SOCIAL_PROFILE');
    expect(classifyOfficialWebsiteHost('youtube.com')).toBe('SOCIAL_PROFILE');
    expect(classifyOfficialWebsiteHost('x.com')).toBe('SOCIAL_PROFILE');
    expect(classifyOfficialWebsiteHost('indeed.com')).toBe('DIRECTORY');
    expect(classifyOfficialWebsiteHost('rocketreach.co')).toBe('DIRECTORY');
    expect(classifyOfficialWebsiteHost('clutch.co')).toBe('REVIEW_SITE');
    expect(classifyOfficialWebsiteHost('goodfirms.co')).toBe('REVIEW_SITE');
    expect(classifyOfficialWebsiteHost('quora.com')).toBe('GENERIC_THIRD_PARTY_PAGE');
    expect(classifyOfficialWebsiteHost('homelight.com')).toBe('GENERIC_THIRD_PARTY_PAGE');
    expect(classifyOfficialWebsiteHost('forbes.com')).toBe('NEWS_ARTICLE');
  });

  it('rejects a website that belongs to a different company', () => {
    const decision = evaluateOfficialWebsite({
      companyName: 'Oak Stream Investors',
      city: 'Austin',
      state: 'Texas',
      url: 'https://cedar-range.example/',
      title: 'Cedar Range Capital | Home',
      text: 'Cedar Range Capital is a real estate investment firm in Dallas.',
      html: '<h1>Cedar Range Capital</h1>',
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toMatch(/DIFFERENT_COMPANY|INSUFFICIENT_COMPANY_MATCH/);
  });

  it('accepts an official site with company and location evidence', () => {
    const decision = evaluateOfficialWebsite({
      companyName: 'Oak Stream Investors',
      city: 'Austin',
      state: 'Texas',
      url: 'https://oakstream.example/',
      title: 'Oak Stream Investors | Home',
      text: 'Oak Stream Investors is a real estate investment company in Austin, Texas. Call 512-555-0100.',
      html: '<h1>Oak Stream Investors</h1>',
    });
    expect(decision).toMatchObject({ accepted: true, reason: 'OFFICIAL_WEBSITE' });
  });

  it('prioritizes about/team/contact and commercial pages over generic links', () => {
    expect(prioritizeCompanyPages([
      'https://oak.example/privacy',
      'https://oak.example/services',
      'https://oak.example/blog/post',
      'https://oak.example/about',
      'https://oak.example/portfolio',
      'https://oak.example/contact',
    ])).toEqual([
      'https://oak.example/about',
      'https://oak.example/contact',
      'https://oak.example/services',
      'https://oak.example/portfolio',
      'https://oak.example/privacy',
      'https://oak.example/blog/post',
    ]);
  });

  it('keeps company social profiles and rejects another company profile', () => {
    const profiles = publicCompanyProfiles('Oak Stream Investors', [
      { url: 'https://www.linkedin.com/company/oak-stream/', title: 'Oak Stream Investors | LinkedIn', snippet: 'Austin real estate investors' },
      { url: 'https://www.linkedin.com/company/oak-street-capital/', title: 'Oak Street Capital | LinkedIn', snippet: 'Oak Street Capital investments' },
      { url: 'https://www.facebook.com/oakstream', title: 'Oak Stream Investors', snippet: 'Austin' },
      { url: 'https://x.com/oakstream', title: 'Oak Stream Investors', snippet: 'Official account' },
    ]);
    expect(profiles).toEqual(expect.arrayContaining([
      'https://www.linkedin.com/company/oak-stream',
      'https://www.facebook.com/oakstream',
      'https://x.com/oakstream',
    ]));
    expect(profiles).not.toContain('https://www.linkedin.com/company/oak-street-capital');
  });

  it('does not run employee-size discovery for qualitative or missing size requests', () => {
    expect(employeeSizeRequested({})).toBe(false);
    expect(employeeSizeRequested({ employeeSize: { qualitative: 'small' } })).toBe(false);
    expect(employeeSizeRequested({ companySize: {} })).toBe(false);
  });

  it('runs employee-size discovery only for numeric SearchPlan bounds and never invents 1-50', () => {
    expect(employeeSizeRequested({ companySize: { min: 10, max: 100 } })).toBe(true);
    expect(employeeSizeRequested({ employeeSize: { exact: 25 } })).toBe(true);
    expect(employeeSizeRequested({ employeeRange: { min: 1, max: 50 } })).toBe(true);
    expect(employeeSizeRequested({ industry: ['software'], locations: [{ country: 'US' }], requestedCount: 50 })).toBe(false);
  });
});
