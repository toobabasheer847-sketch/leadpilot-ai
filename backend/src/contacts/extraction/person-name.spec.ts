import { isPlausiblePersonName } from './person-name';

describe('isPlausiblePersonName', () => {
  it('rejects UI chrome and company/role phrases', () => {
    expect(isPlausiblePersonName('Share Article')).toBe(false);
    expect(isPlausiblePersonName('Related Posts')).toBe(false);
    expect(isPlausiblePersonName('Houston House Flipper')).toBe(false);
    expect(isPlausiblePersonName('Real Estate')).toBe(false);
    expect(isPlausiblePersonName('Search Menu')).toBe(false);
  });

  it('accepts ordinary person names and rejects company-token clones', () => {
    expect(isPlausiblePersonName('Jane Doe')).toBe(true);
    expect(isPlausiblePersonName('Mary Ann Smith')).toBe(true);
    expect(isPlausiblePersonName('Oak Stream', 'Oak Stream Investors')).toBe(false);
  });
});
