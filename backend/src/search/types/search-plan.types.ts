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
  unresolvedCriteria: UnresolvedCriterion[];
}
