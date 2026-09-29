import { isPersistableDiscoveryCandidate, rejectDiscoveryUrl } from './discovery-candidate.gate';

describe('discovery candidate gate', () => {
  it('rejects clutch, goodfirms, quora, homelight, and blog/directory/guide paths before persist', () => {
    expect(rejectDiscoveryUrl('https://clutch.co/profile/acme')).toBe('REVIEW_SITE');
    expect(rejectDiscoveryUrl('https://www.goodfirms.co/company/acme')).toBe('REVIEW_SITE');
    expect(rejectDiscoveryUrl('https://www.quora.com/Why-invest')).toBe('GENERIC_THIRD_PARTY_PAGE');
    expect(rejectDiscoveryUrl('https://www.homelight.com/blog/cash-buyers')).toBe('GENERIC_THIRD_PARTY_PAGE');
    expect(rejectDiscoveryUrl('https://oakstream.example/blog/post')).toBe('GENERIC_LIST');
    expect(rejectDiscoveryUrl('https://oakstream.example/directory/list')).toBe('GENERIC_LIST');
    expect(rejectDiscoveryUrl('https://oakstream.example/guides/texas')).toBe('GENERIC_LIST');
    expect(rejectDiscoveryUrl('https://oakstream.example/about')).toBeNull();
  });

  it('blocks persist when website or sourceUrl is a directory/blog host', () => {
    expect(isPersistableDiscoveryCandidate({
      website: 'https://clutch.co/profile/acme',
      sourceUrl: 'https://clutch.co/profile/acme',
    })).toEqual({ ok: false, reason: 'REVIEW_SITE' });
    expect(isPersistableDiscoveryCandidate({
      website: 'https://oakstream.example',
      sourceUrl: 'https://oakstream.example/contact',
    })).toEqual({ ok: true });
  });
});
