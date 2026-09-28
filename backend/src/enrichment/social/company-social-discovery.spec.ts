import { prioritizeCompanyPages } from '../website/website-discovery.service';
import { publicCompanyProfiles } from './company-social-discovery.service';

describe('public company profiles', () => {
  it('keeps a company profile named in the search hit and drops person profiles and posts', () => {
    const profiles = publicCompanyProfiles('Oak Stream Investors', [
      { url: 'https://www.linkedin.com/company/oak-stream/', title: 'Oak Stream Investors | LinkedIn', snippet: 'Oak Stream Investors' },
      { url: 'https://www.linkedin.com/in/jane-doe', title: 'Jane Doe | Oak Stream Investors', snippet: 'CEO' },
      { url: 'https://www.facebook.com/oakstream', title: 'Oak Stream Investors', snippet: 'Austin' },
      { url: 'https://x.com/oakstream/status/1', title: 'Oak Stream Investors', snippet: 'post' },
      { url: 'https://www.instagram.com/other-brand', title: 'Other Brand', snippet: 'unrelated' },
    ]);
    expect(profiles).toEqual([
      'https://www.linkedin.com/company/oak-stream',
      'https://www.facebook.com/oakstream',
    ]);
  });

  it('fetches about and team pages before unrelated links', () => {
    expect(prioritizeCompanyPages([
      'https://oak.example/privacy',
      'https://oak.example/team',
      'https://oak.example/blog/post',
      'https://oak.example/contact',
    ])).toEqual([
      'https://oak.example/team',
      'https://oak.example/contact',
      'https://oak.example/privacy',
      'https://oak.example/blog/post',
    ]);
  });
});
