import { fillEmptyCompanyFields, phoneMatchKey } from './company-field-merge';

describe('company field merge', () => {
  it('fills empty fields and preserves conflicting values', () => {
    expect(fillEmptyCompanyFields(
      { website: 'https://existing.test', phone: null, category: 'Existing', googlePlaceId: 'place-1' },
      { website: 'https://incoming.test', phone: '5125550100', category: 'Incoming', googlePlaceId: 'place-2' },
    )).toEqual({ phone: '5125550100' });
  });

  it('fills an empty email and preserves an existing email', () => {
    expect(fillEmptyCompanyFields({ email: null }, { email: 'office@example.com' })).toEqual({ email: 'office@example.com' });
    expect(fillEmptyCompanyFields({ email: 'existing@example.com' }, { email: 'other@example.com' })).toEqual({});
  });

  it('matches only sufficiently specific phone numbers', () => {
    expect(phoneMatchKey('+1 (512) 555-0100')).toBe('15125550100');
    expect(phoneMatchKey('555-0100')).toBeNull();
  });
});
