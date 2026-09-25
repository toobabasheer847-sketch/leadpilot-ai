import { SourceNormalizerService } from './source-normalizer.service';

describe('SourceNormalizerService', () => {
  it('normalizes identifiers while preserving provenance and missing fields', () => {
    const result = new SourceNormalizerService().normalize({
      externalId: ' place-1 ',
      name: ' Example Business ',
      sourceUrl: 'https://example.test/source',
      website: 'HTTPS://EXAMPLE.TEST/',
      address: { state: ' Texas ', country: 'us' },
    });

    expect(result).toMatchObject({
      externalId: 'place-1',
      name: 'Example Business',
      sourceUrl: 'https://example.test/source',
      website: 'https://example.test',
      address: { state: 'Texas', country: 'US' },
    });
    expect(result.phone).toBeUndefined();
  });

  it('normalizes a phone without inventing a country code', () => {
    const result = new SourceNormalizerService().normalize({
      externalId: 'place-1',
      name: 'Example Business',
      sourceUrl: 'https://example.test/source',
      phone: '(512) 555-0100',
    });
    expect(result.phone).toBe('5125550100');
  });

  it('keeps a real email and drops a missing or invalid one', () => {
    const service = new SourceNormalizerService();
    expect(service.normalize({
      externalId: 'place-1',
      name: 'Example Business',
      sourceUrl: 'https://example.test/source',
      email: 'Owner@Example.TEST',
    }).email).toBe('owner@example.test');
    expect(service.normalize({
      externalId: 'place-1',
      name: 'Example Business',
      sourceUrl: 'https://example.test/source',
    }).email).toBeUndefined();
    expect(service.normalizeEmail('not an email')).toBeUndefined();
  });

  it('rejects records without a factual source URL', () => {
    expect(() => new SourceNormalizerService().normalize({ externalId: 'place-1', name: 'Company', sourceUrl: '' })).toThrow('required provenance');
  });
});
