export interface SearchLocation {
  country?: string;
  state?: string;
  city?: string;
  /** Province, metro, or other place that is not a city or a known state. */
  region?: string;
  postalCode?: string;
  originalText?: string;
}

export interface CompanySize {
  min?: number;
  max?: number;
  exact?: number;
  qualitative?: string;
}

export interface UnresolvedCriterion {
  text: string;
  reason: string;
}

export interface SearchPlan {
  /** User's requested output kind. This does not change discovered-company counts. */
  targetType?: 'COMPANIES' | 'QUALIFIED_LEADS';
  industry: string[];
  leadTypes: string[];
  category?: string;
  locations: SearchLocation[];
  companySize?: CompanySize;
  employeeSize?: CompanySize;
  companyFields: string[];
  personFields?: string[];
  socialPlatforms?: string[];
  contactRequirements?: {
    titles: string[];
    fields: string[];
  };
  /** Explicit required company/contact fields for qualification (dynamic). */
  requiredFields?: string[];
  /** Explicit optional fields reported but never disqualifying alone. */
  optionalFields?: string[];
  /** Natural-language preferences, kept separate from hard qualification criteria. */
  preferredFields?: string[];
  /** Alias of contactRequirements.titles for qualification. */
  requiredRoles?: string[];
  decisionMakerRoles?: string[];
  emailRequirement?: { requested: boolean; required: boolean; verified: boolean };
  websiteRequirement?: { requested: boolean; required: boolean };
  verificationRequirement?: { requested: boolean; required: boolean; fields: string[] };
  /** Soft score floor; never overrides required criteria failures. */
  minimumScore?: number;
  /** Upper bound requested by the prompt. Same value as requestedCount when the prompt states a number. */
  maxResults?: number;
  /** Count taken from the prompt. Absent only when the prompt does not state a number. */
  requestedCount?: number;
  /** How the prompt qualified the count. "at least" is a minimum goal, not a silent default. */
  countIntent?: 'exact' | 'maximum' | 'minimum' | 'approximate';
  /** Same bounds as companySize when the prompt requested an employee range. */
  employeeRange?: CompanySize;
  /** Businesses or categories the prompt told the search to leave out. */
  exclusions?: string[];
  /** Short description of what the prompt asked the search to find. */
  searchIntent?: string;
  unresolvedCriteria: UnresolvedCriterion[];
  unresolvedRequirements?: UnresolvedCriterion[];
  originalPrompt?: string;
  planning?: {
    method: 'ai' | 'deterministic_fallback';
    model?: string;
    error?: string;
  };
}
