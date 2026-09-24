export const MATCH_WEIGHTS = {
  domain: 40,
  phone: 25,
  social: 25,
  placeId: 30,
  address: 20,
  name: 15,
  location: 10,
  emailDomain: 5,
  contactEmail: 60,
  contactPhone: 35,
  contactSocial: 35,
  contactNameCompany: 25,
  title: 5,
} as const;

export const AUTO_DUPLICATE_THRESHOLD = 60;
export const REVIEW_THRESHOLD = 30;
