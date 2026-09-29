export const SCORING_VERSION = 'v2';

export const SCORING_WEIGHTS = {
  /** Shared weight for AI classification match against the user's requested criteria. */
  classificationMatch: 25,
  /** Investor-only acquisition evidence. Kept for investor-mode searches. */
  acquisitionEvidence: 15,
  companyIdentity: 10,
  officialWebsite: 8,
  location: 7,
  decisionMaker: 8,
  decisionMakerTitle: 5,
  professionalProfile: 4,
  businessEmail: 4,
  businessPhone: 2,
  companySize: 2,
  investmentStrategy: 2,
  marketsServed: 1,
  propertyType: 1,
  evidenceFreshness: 3,
  sourceDiversity: 3,
} as const;

/** @deprecated Use classificationMatch. Kept as an alias for older references. */
export const investorClassification = SCORING_WEIGHTS.classificationMatch;

export const CONFLICT_PENALTY = 10;
