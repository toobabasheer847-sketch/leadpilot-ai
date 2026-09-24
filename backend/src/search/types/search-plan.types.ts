export interface SearchLocation {
  country: string;
  state?: string;
  city?: string;
}

export interface CompanySize {
  min?: number;
  max?: number;
}

export interface UnresolvedCriterion {
  text: string;
  reason: string;
}

export interface SearchPlan {
  industry: string[];
  leadTypes: string[];
  locations: SearchLocation[];
  companySize?: CompanySize;
  companyFields: string[];
  contactRequirements?: {
    titles: string[];
    fields: string[];
  };
  /** Explicit required company/contact fields for qualification (dynamic). */
  requiredFields?: string[];
  /** Explicit optional fields reported but never disqualifying alone. */
  optionalFields?: string[];
  /** Alias of contactRequirements.titles for qualification. */
  requiredRoles?: string[];
  /** Soft score floor; never overrides required criteria failures. */
  minimumScore?: number;
  unresolvedCriteria: UnresolvedCriterion[];
}
