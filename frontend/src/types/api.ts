export interface AuthUser {
  id: string;
  name: string;
  email: string;
  organization: {
    id: string;
    name: string;
  };
  role: string;
}

export interface AuthSession {
  accessToken: string;
  user: AuthUser;
}

export interface PageResult<T> {
  data?: T[];
  items?: T[];
  total?: number;
  page?: number;
  limit?: number;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface SearchRecord {
  id: string;
  name: string;
  originalPrompt: string | null;
  status: string;
  criteria: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SearchPreview {
  originalPrompt: string;
  structuredPlan: {
    industry?: string[];
    leadTypes?: string[];
    locations?: Array<{ country?: string; state?: string; city?: string }>;
    companySize?: { min?: number; max?: number };
  };
}

export interface PipelineStageMap {
  search: StageState;
  sourceDiscovery: StageState;
  companyPersistence: StageState;
  websiteDiscovery: StageState;
  enrichment: StageState;
  deepResearch: StageState;
  decisionMakerDiscovery: StageState;
  contactQuality: StageState;
  evidence: StageState;
  classification: StageState;
  verification: StageState;
  deduplication: StageState;
  scoring: StageState;
  qualification: StageState;
}

export type StageState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface PipelineStageStatus {
  name: string;
  status: StageState;
}

export interface PipelineCounters {
  companiesDiscovered: number | null;
  companiesProcessed: number | null;
  websitesResearched: number | null;
  decisionMakersFound: number | null;
  contactsFound: number | null;
  evidenceCollected: number | null;
  verifiedFields: number | null;
  conflictsFound: number | null;
  duplicatesFound: number | null;
  qualifiedLeads: number | null;
}

export interface PipelineFailure {
  stage: string;
  message: string;
}

export interface PipelineView {
  pipelineExecutionId: string;
  executionId: string | null;
  searchId: string;
  searchExecutionId: string | null;
  status: 'QUEUED' | 'RUNNING' | 'PARTIAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  currentStage: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  stages: PipelineStageMap;
  stageList: PipelineStageStatus[];
  counters: PipelineCounters;
  failures: PipelineFailure[];
  error: { code: string; message: string } | null;
}

export interface SearchExecutionSummary {
  id: string;
  searchId: string | null;
  userPrompt: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  resultCount: number;
  companyCount: number;
  qualifiedLeadCount: number;
}

export interface LeadLocation {
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  address: string | null;
}

export interface EvidenceItem {
  id?: string;
  sourceUrl?: string | null;
  sourceType?: string | null;
  evidenceType?: string | null;
  excerpt?: string | null;
  evidenceText?: string | null;
  timestamp?: string | null;
  evidenceTimestamp?: string | null;
  retrievedAt?: string | null;
  createdAt?: string | null;
  metadata?: unknown;
}

export interface SocialProfileRow {
  platform: string;
  profileUrl: string | null;
  username?: string | null;
  verificationStatus?: string | null;
}

export interface SocialProfileMap {
  linkedin?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  youtube?: string | null;
  x?: string | null;
  twitter?: string | null;
}

export interface LeadRecord {
  id: string;
  company: {
    id: string;
    name: string | null;
    website: string | null;
    domain?: string | null;
    phone?: string | null;
    email?: string | null;
    description?: string | null;
    category?: string | null;
    investorType: string | null;
    investmentStrategy?: string | null;
    propertyTypes?: unknown;
    marketsServed?: unknown;
    companySize?: string | number | null;
    location: LeadLocation | null;
  };
  contact: {
    id: string;
    name: string | null;
    title: string | null;
    email: string | null;
    phone: string | null;
    linkedin?: string | null;
    facebook?: string | null;
    instagram?: string | null;
  } | null;
  socialProfiles?: SocialProfileRow[];
  classification: { decision: string | null; confidence: number | string | null } | null;
  score: { value: number; band: string | null; breakdown?: unknown } | null;
  verification: { status: string; field: string | null } | null;
  qualification: { status: string; score?: number | null; scoreBand?: string | null } | null;
  duplicate?: { status: string; matchType?: string | null; confidence?: number | null } | null;
  evidence: EvidenceItem[];
  sourceUrls?: string[];
  createdAt: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
}

export interface CompanyProfile {
  id: string;
  name: string | null;
  website: string | null;
  description: string | null;
  category: string | null;
  investorType: string | null;
  investmentStrategy: string | null;
  propertyTypes: unknown;
  marketsServed: unknown;
  phone: string | null;
  email: string | null;
  verificationStatus: string | null;
  lastVerifiedAt: string | null;
  socialProfiles: SocialProfileMap;
  evidenceCount: number;
}

export interface DecisionMaker {
  id: string;
  fullName: string | null;
  name?: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  phoneStatus: string | null;
  linkedinUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  youtubeUrl: string | null;
  verificationStatus: string | null;
  socialProfileStatus?: {
    linkedin?: string | null;
    facebook?: string | null;
    instagram?: string | null;
    youtube?: string | null;
  };
  evidenceSummary?: {
    independentSources?: number;
    conflictCount?: number;
  };
}

export interface VerificationField {
  fieldName: string;
  fieldValue: string | null;
  status: string;
  verificationStatus: string | null;
  contactId: string | null;
  checkedAt: string | null;
  metadata: unknown;
}

export interface VerificationConflict {
  id: string;
  fieldName: string;
  valueA: string;
  valueB: string;
  sourceTypeA: string | null;
  sourceUrlA: string | null;
  sourceTypeB: string | null;
  sourceUrlB: string | null;
  evidenceExcerptA?: string | null;
  evidenceExcerptB?: string | null;
  status: string;
}

export interface VerificationSummary {
  verificationStatus: string | null;
  fields: VerificationField[];
  evidenceCount: number;
  sourceCount: number;
  conflicts: VerificationConflict[];
  requiresReview: boolean;
  lastVerifiedAt: string | null;
}

export interface EvidenceReference {
  evidenceId?: string;
  reason?: string;
}

export interface ClassificationRecord {
  decision: string | null;
  classification: string | null;
  confidence: string | number | null;
  investorType: string | null;
  category: string | null;
  positiveEvidence?: EvidenceReference[];
  negativeEvidence?: EvidenceReference[];
}

export interface ResearchExecution {
  id: string;
  companyId: string;
  status: string;
  pagesDiscovered: number;
  pagesProcessed: number;
  fieldsExtracted: number;
  fieldsVerified: number;
  conflictsFound: number;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  progress?: {
    pagesDiscovered: number;
    pagesProcessed: number;
    fieldsExtracted: number;
    fieldsVerified: number;
    conflictsFound: number;
  };
}

export interface ExportRecord {
  id: string;
  format: 'csv' | 'xlsx';
  status: string;
  rowCount: number | null;
  fileName: string | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export type LeadSortBy = 'score' | 'companyName' | 'createdAt' | 'updatedAt' | 'lastVerifiedAt';

export interface LeadFilters {
  page?: number;
  limit?: number;
  sortBy?: LeadSortBy;
  sortOrder?: 'asc' | 'desc';
  search?: string;
  state?: string;
  city?: string;
  country?: string;
  zipCode?: string;
  investorType?: string;
  qualificationStatus?: string;
  verificationStatus?: string;
  classification?: string;
  minScore?: number;
  maxScore?: number;
  scoreBand?: string;
  searchExecutionId?: string;
  companyName?: string;
  hasDecisionMaker?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
}
