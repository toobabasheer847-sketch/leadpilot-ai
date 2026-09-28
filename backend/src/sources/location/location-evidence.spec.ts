import { applyGeocodedLocation, pointInsideBox, sameCountry, toCountryCode } from './location-evidence';

const dubai = {
  label: 'Dubai, United Arab Emirates',
  bbox: { south: 24.8, west: 54.8, north: 25.4, east: 55.6 },
  city: 'Dubai',
  state: 'Dubai',
  countryCode: 'AE',
};

describe('location evidence', () => {
  it('normalizes equivalent country names and codes', () => {
    expect(toCountryCode('United Arab Emirates')).toBe('AE');
    expect(toCountryCode('pk')).toBe('PK');
    expect(sameCountry('Germany', 'DE')).toBe(true);
    expect(sameCountry('United Kingdom', 'GB')).toBe(true);
    expect(sameCountry('USA', 'United States')).toBe(true);
    expect(sameCountry('Pakistan', 'AE')).toBe(false);
  });

  it('fills a missing city from coordinates inside the geocoded boundary', () => {
    const filled = applyGeocodedLocation({
      name: 'Qantarah',
      address: { latitude: 25.2, longitude: 55.27 },
    }, dubai);
    expect(filled.address).toMatchObject({ city: 'Dubai', country: 'AE' });
    expect(filled.rawData?.locationEvidence).toMatchObject({ source: 'geocoded-boundary', label: dubai.label });
  });

  it('does not invent a location from a name or from a point outside the boundary', () => {
    const outside = applyGeocodedLocation({
      name: 'Dubai Palace Restaurant',
      address: { latitude: 51.5, longitude: -0.12 },
    }, dubai);
    expect(outside.address?.city).toBeUndefined();
    expect(outside.address?.country).toBeUndefined();
    expect(pointInsideBox(25.2, 55.27, dubai.bbox)).toBe(true);
    expect(pointInsideBox(51.5, -0.12, dubai.bbox)).toBe(false);
  });

  it('keeps an explicit address and normalizes its country code', () => {
    const kept = applyGeocodedLocation({
      name: 'House',
      address: { city: 'Lahore', country: 'Pakistan', latitude: 31.5, longitude: 74.3 },
    }, {
      label: 'Lahore, Pakistan',
      bbox: { south: 31.3, west: 74.1, north: 31.7, east: 74.5 },
      city: 'Lahore',
      countryCode: 'PK',
    });
    expect(kept.address).toMatchObject({ city: 'Lahore', country: 'PK' });
  });
});
