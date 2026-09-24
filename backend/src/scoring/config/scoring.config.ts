export const SCORING_VERSION = 'v1';

export const SCORING_WEIGHTS = {
  investorClassification: 25,
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

export const CONFLICT_PENALTY = 10;
