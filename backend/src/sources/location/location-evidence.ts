export interface GeoBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GeocodedPlace {
  label: string;
  bbox: GeoBox;
  city?: string;
  state?: string;
  countryCode?: string;
}

const COUNTRIES: Record<string, string> = {
  us: 'US',
  usa: 'US',
  'united states': 'US',
  'united states of america': 'US',
  ae: 'AE',
  uae: 'AE',
  'united arab emirates': 'AE',
  pk: 'PK',
  pakistan: 'PK',
  de: 'DE',
  germany: 'DE',
  deutschland: 'DE',
  gb: 'GB',
  uk: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  ca: 'CA',
  canada: 'CA',
  fr: 'FR',
  france: 'FR',
  au: 'AU',
  australia: 'AU',
  in: 'IN',
  india: 'IN',
  nl: 'NL',
  netherlands: 'NL',
  es: 'ES',
  spain: 'ES',
  it: 'IT',
  italy: 'IT',
  br: 'BR',
  brazil: 'BR',
  mx: 'MX',
  mexico: 'MX',
  jp: 'JP',
  japan: 'JP',
  cn: 'CN',
  china: 'CN',
  sg: 'SG',
  singapore: 'SG',
  ie: 'IE',
  ireland: 'IE',
  nz: 'NZ',
  'new zealand': 'NZ',
  za: 'ZA',
  'south africa': 'ZA',
  sa: 'SA',
  'saudi arabia': 'SA',
  qa: 'QA',
  qatar: 'QA',
  eg: 'EG',
  egypt: 'EG',
  ng: 'NG',
  nigeria: 'NG',
  ke: 'KE',
  kenya: 'KE',
};

export function toCountryCode(value: string | undefined | null): string | undefined {
  if (!value?.trim()) return undefined;
  const key = value.trim().toLowerCase();
  if (COUNTRIES[key]) return COUNTRIES[key];
  if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase();
  return undefined;
}

export function sameCountry(left: string | undefined | null, right: string | undefined | null): boolean {
  const a = toCountryCode(left);
  const b = toCountryCode(right);
  return Boolean(a && b && a === b);
}

export function pointInsideBox(latitude: number, longitude: number, box: GeoBox): boolean {
  return latitude >= box.south && latitude <= box.north && longitude >= box.west && longitude <= box.east;
}

export interface LocationFields {
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  addressLine1?: string;
  addressLine2?: string;
}

/** Fills only missing fields when coordinates sit inside a geocoded boundary. Never uses the company name. */
export function applyGeocodedLocation<T extends { address?: LocationFields; rawData?: Record<string, unknown> }>(
  result: T,
  place: GeocodedPlace,
): T {
  const address: LocationFields = { ...result.address };
  if (address.country) address.country = toCountryCode(address.country) ?? undefined;
  const latitude = address.latitude;
  const longitude = address.longitude;
  const inside = typeof latitude === 'number' && typeof longitude === 'number' && pointInsideBox(latitude, longitude, place.bbox);
  const filled: string[] = [];
  if (inside) {
    if (!address.city && place.city) {
      address.city = place.city;
      filled.push('city');
    }
    if (!address.state && place.state) {
      address.state = place.state;
      filled.push('state');
    }
    if (!address.country && place.countryCode) {
      address.country = place.countryCode;
      filled.push('country');
    }
  }
  const countryChanged = address.country !== result.address?.country;
  if (!filled.length && !countryChanged) return result;
  return {
    ...result,
    address,
    rawData: {
      ...result.rawData,
      ...(filled.length ? {
        locationEvidence: {
          source: 'geocoded-boundary',
          label: place.label,
          filled,
          latitude,
          longitude,
        },
      } : {}),
    },
  };
}
