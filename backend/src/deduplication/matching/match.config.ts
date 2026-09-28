export const MATCH_WEIGHTS = {
  domain: 55,
  verifiedPhone: 55,
  verifiedEmail: 55,
  phone: 20,
  social: 25,
  placeId: 55,
  externalId: 55,
  address: 15,
  name: 10,
  location: 8,
  emailDomain: 5,
  contactVerifiedEmail: 60,
  contactEmail: 25,
  contactPhone: 20,
  contactLinkedIn: 55,
  contactSocial: 30,
  contactNameCompany: 30,
  title: 25,
} as const;

/** Hard identity or combined strong signals must reach this to auto-merge. */
export const AUTO_DUPLICATE_THRESHOLD = 55;
/** Ambiguous fuzzy / soft matches land in review — never auto-merge. */
export const REVIEW_THRESHOLD = 30;
/** Name+location fuzzy alone must be exact-name equality and still only review. */
export const FUZZY_REVIEW_MAX_SCORE = 40;
