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

  it('rejects records without a factual source URL', () => {
    expect(() => new SourceNormalizerService().normalize({ externalId: 'place-1', name: 'Company', sourceUrl: '' })).toThrow('required provenance');
  });
});
