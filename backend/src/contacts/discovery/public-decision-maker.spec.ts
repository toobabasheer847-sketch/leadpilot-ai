import { publicPersonEmail } from '../extraction/contact-extractor.service';
import { assessPublicDecisionMaker, decisionMakerQueries } from './public-decision-maker';

describe('public decision maker discovery', () => {
  it('builds company-scoped title queries', () => {
    expect(decisionMakerQueries('Oak Stream Investors')).toEqual([
      '"Oak Stream Investors" Founder',
      '"Oak Stream Investors" CEO',
      '"Oak Stream Investors" President',
      '"Oak Stream Investors" Owner',
      '"Oak Stream Investors" "Managing Director"',
    ]);
  });

  it('builds role-filtered queries from SearchPlan roles', () => {
    expect(decisionMakerQueries('Oak Stream Investors', ['CEO', 'Founder'])).toEqual([
      '"Oak Stream Investors" CEO',
      '"Oak Stream Investors" Founder',
    ]);
  });

  it('accepts a person only when the snippet associates them with the company and a title', () => {
    const candidate = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe - Founder - Oak Stream Investors | LinkedIn',
      url: 'https://www.linkedin.com/in/jane-doe',
      snippet: 'Jane Doe is Founder of Oak Stream Investors in Austin, Texas. Reach Jane at jane.doe@oakstream.example.',
      source: 'tavily',
      retrievedAt: '2026-09-28T00:00:00.000Z',
    });
    expect(candidate).toMatchObject({
      fullName: 'Jane Doe',
      title: 'Founder',
      email: 'jane.doe@oakstream.example',
      emailStatus: 'UNVERIFIED',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      verificationStatus: 'NOT_VERIFIED',
      companyRelationship: 'Oak Stream Investors',
    });
    expect(candidate?.evidence.map((item) => item.field)).toEqual(expect.arrayContaining(['fullName', 'title', 'companyRelationship', 'email']));
  });

  it('does not accept a name that is not tied to the company', () => {
    expect(assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, Founder of Northwind Capital',
      url: 'https://www.linkedin.com/in/jane-doe',
      snippet: 'Jane Doe founded Northwind Capital.',
    })).toBeNull();
  });

  it('rejects generic and guessed decision-maker emails', () => {
    expect(publicPersonEmail('Email the office at office@oakstream.example or info@oakstream.example')).toBeNull();
    expect(publicPersonEmail('Jane Doe is Founder of Oak Stream Investors. Website oakstream.example')).toBeNull();
    const candidate = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, CEO of Oak Stream Investors',
      url: 'https://oakstream.example/team',
      snippet: 'Jane Doe, CEO of Oak Stream Investors. Contact office@oakstream.example.',
    });
    expect(candidate?.fullName).toBe('Jane Doe');
    expect(candidate?.email).toBeNull();
    expect(candidate?.emailStatus).toBe('NOT_FOUND');
  });

  it('does not attach a person from a different company with a similar page mention', () => {
    expect(assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, CEO of Northwind Capital',
      url: 'https://www.linkedin.com/in/jane-doe',
      snippet: 'Jane Doe is CEO of Northwind Capital. A directory also lists Oak Stream Investors.',
    })).toBeNull();
  });

  it('rejects generic mailbox local parts', () => {
    for (const local of ['info', 'contact', 'office', 'support', 'sales', 'hello', 'admin']) {
      expect(publicPersonEmail(`${local}@oak.example`)).toBeNull();
    }
    expect(publicPersonEmail('Jane Doe can be reached at jane.doe@oak.example')).toBe('jane.doe@oak.example');
  });

  it('keeps a company social page off the person profile', () => {
    const candidate = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, Founder of Oak Stream Investors',
      url: 'https://www.linkedin.com/company/oak-stream-investors',
      snippet: 'Jane Doe is Founder of Oak Stream Investors. jane.doe@oakstream.example',
    });
    expect(candidate?.linkedinUrl).toBeUndefined();
    expect(candidate?.email).toBe('jane.doe@oakstream.example');
    expect(candidate?.firstName).toBe('Jane');
    expect(candidate?.lastName).toBe('Doe');
  });

  it('does not treat a company LinkedIn page as the person profile', () => {
    const candidate = assessPublicDecisionMaker('Oak Stream Investors', {
      title: 'Jane Doe, Managing Partner at Oak Stream Investors',
      url: 'https://www.linkedin.com/company/oak-stream-investors',
      snippet: 'Jane Doe is Managing Partner at Oak Stream Investors.',
    });
    expect(candidate?.fullName).toBe('Jane Doe');
    expect(candidate?.title).toBe('Managing Partner');
    expect(candidate?.linkedinUrl).toBeUndefined();
  });
});
