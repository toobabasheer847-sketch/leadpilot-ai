import { canAttachDiscoveryToOrganization, canMatchDiscoveredCompanyByName, discoveredLocationsAgree } from './source-discovery.service';

describe('discovery organization isolation', () => {
  it('does not attach a discovered company to a different organization', () => {
    expect(canAttachDiscoveryToOrganization('org-a', 'org-a')).toBe(true);
    expect(canAttachDiscoveryToOrganization('org-a', 'org-b')).toBe(false);
    expect(canAttachDiscoveryToOrganization('', 'org-a')).toBe(false);
  });

  it('does not treat the same name in different places as one company', () => {
    expect(canMatchDiscoveredCompanyByName({ city: 'Austin', state: 'Texas' })).toBe(true);
    expect(canMatchDiscoveredCompanyByName({ city: 'Austin' })).toBe(true);
    expect(canMatchDiscoveredCompanyByName({ state: 'Texas' })).toBe(false);
    expect(canMatchDiscoveredCompanyByName({})).toBe(false);
    expect(canMatchDiscoveredCompanyByName(undefined)).toBe(false);
  });

  it('does not treat distant offices with the same name as one company', () => {
    expect(discoveredLocationsAgree('32.9009570', '-96.9594321', 32.901, -96.959)).toBe(true);
    expect(discoveredLocationsAgree('32.9009570', '-96.9594321', 30.1622, -95.4609)).toBe(false);
    expect(discoveredLocationsAgree('36.0520815', '-95.7916520', 33.5829, -102.3673)).toBe(false);
    expect(discoveredLocationsAgree(null, null, 32.9, -96.9)).toBe(true);
    expect(discoveredLocationsAgree(null, null, undefined, undefined, 'Dallas', 'Houston')).toBe(false);
    expect(discoveredLocationsAgree(null, null, undefined, undefined, 'Dallas', 'Dallas')).toBe(true);
    expect(discoveredLocationsAgree(null, null, undefined, undefined, 'Dallas', undefined)).toBe(true);
  });
});
