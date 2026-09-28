import { assessCategoryEvidence } from './category-evidence';

describe('category evidence', () => {
  it('rejects a different trade and does not treat the company name as proof', () => {
    expect(assessCategoryEvidence({
      requested: ['software'],
      text: 'Desk Repair Co provides computer repair and it support.',
      companyName: 'Desk Repair Co',
      taggedCategory: 'it',
    }).verdict).toBe('NO_MATCH');

    expect(assessCategoryEvidence({
      requested: ['software'],
      text: 'Northwind Software',
      companyName: 'Northwind Software',
    })).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'CATEGORY_NAME_ONLY' });
  });

  it('accepts evidence of the requested activity and flags mixed evidence for review', () => {
    expect(assessCategoryEvidence({
      requested: ['software'],
      text: 'Northwind builds developer tools for clinics.',
      companyName: 'Northwind',
    }).verdict).toBe('MATCH');

    expect(assessCategoryEvidence({
      requested: ['marketing'],
      text: 'Bright Path is an advertising agency in Berlin.',
      companyName: 'Bright Path',
      taggedCategory: 'advertising agency',
    }).verdict).toBe('MATCH');

    expect(assessCategoryEvidence({
      requested: ['restaurant'],
      text: 'Qantarah serves cuisine in the city.',
      companyName: 'Qantarah',
      taggedCategory: 'restaurant',
    }).verdict).toBe('MATCH');

    expect(assessCategoryEvidence({
      requested: ['software'],
      text: 'Northwind builds software and also offers computer repair.',
      companyName: 'Northwind',
    }).verdict).toBe('NEEDS_REVIEW');
  });
});
