import { evaluateOfficialWebsite } from './official-website.validator';

describe('official website validation', () => {
  const oak = {
    companyName: 'Oak Stream Investors',
    city: 'Austin',
    state: 'Texas',
  };

  it('accepts an exact official company website', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://oak.example/',
      title: 'Oak Stream Investors',
      text: 'Oak Stream Investors serves Texas.',
    })).toMatchObject({ accepted: true, reason: 'OFFICIAL_WEBSITE' });
  });

  it('rejects a different company that shares one name token', () => {
    expect(evaluateOfficialWebsite({
      companyName: 'Trinity Investments',
      url: 'https://startupintros.com/trinity',
      title: 'TRINITY: Funding, Team & Investors | Startup Intros',
      text: 'Trinity Capital is an international alternative asset manager.',
    })).toMatchObject({ accepted: false, reason: 'DIFFERENT_COMPANY' });
  });

  it('rejects a directory page', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://listings.example/oak-stream-investors',
      title: 'Oak Stream Investors | Business Directory',
      text: 'View all companies. Oak Stream Investors company profile.',
    })).toMatchObject({ accepted: false, reason: 'DIRECTORY' });
  });

  it('rejects a proxy or filing page', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://materials.proxyvote.com/Approved/26205E/index.html',
      title: 'Oak Stream Investors',
      text: 'He is also the founder of Oak Stream Investors, a private investment firm.',
    })).toMatchObject({ accepted: false, reason: 'PROXY_OR_FILING' });
  });

  it('rejects a social profile', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://www.linkedin.com/company/oak-stream-investors',
      title: 'Oak Stream Investors | LinkedIn',
      text: 'Oak Stream Investors',
    })).toMatchObject({ accepted: false, reason: 'SOCIAL_PROFILE' });
  });

  it('rejects a news article', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://www.forbes.com/sites/example/oak-stream-investors',
      title: 'Oak Stream Investors raises a fund | Forbes',
      text: 'Oak Stream Investors announced a new fund.',
    })).toMatchObject({ accepted: false, reason: 'NEWS_ARTICLE' });
  });

  it('rejects a review or listing page', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://www.yelp.com/biz/oak-stream-investors-austin',
      title: 'Oak Stream Investors - Austin, TX',
      text: 'Reviews for Oak Stream Investors in Austin, Texas.',
    })).toMatchObject({ accepted: false, reason: 'REVIEW_SITE' });
  });

  it('rejects a generic third-party company profile', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://profiles.example/oak-stream-investors',
      title: 'Oak Stream Investors | BizProfiles',
      text: 'Overview of Oak Stream Investors and the markets it serves.',
    })).toMatchObject({ accepted: false, reason: 'GENERIC_THIRD_PARTY_PAGE' });
  });

  it('rejects a weak single-token name match', () => {
    expect(evaluateOfficialWebsite({
      companyName: 'Trinity Investments',
      url: 'https://example.com/trinity',
      title: 'Trinity | Home',
      text: 'Welcome to our page.',
    })).toMatchObject({ accepted: false, reason: 'INSUFFICIENT_COMPANY_MATCH' });
  });

  it('accepts slightly different branding when the domain and location identify the same firm', () => {
    expect(evaluateOfficialWebsite({
      ...oak,
      url: 'https://oakstream.com/',
      title: 'Oak Stream',
      text: 'Oak Stream is a private investment firm in Austin, Texas. Call (512) 555-0100.',
    })).toMatchObject({ accepted: true, reason: 'OFFICIAL_WEBSITE' });
  });

  it('does not accept different branding without corroborating domain, location, or contact evidence', () => {
    expect(evaluateOfficialWebsite({
      companyName: 'Oak Stream Investors',
      url: 'https://random.example/',
      title: 'Oak Stream',
      text: 'Welcome.',
    })).toMatchObject({ accepted: false, reason: 'INSUFFICIENT_COMPANY_MATCH' });
  });
});
