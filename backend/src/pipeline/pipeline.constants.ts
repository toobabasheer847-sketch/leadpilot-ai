export const LEAD_PIPELINE_QUEUE = 'lead-pipeline-queue';
export const LEAD_PIPELINE_JOB = 'LEAD_PIPELINE';
export const MAX_STAGE_WAITS = 120;
export const STAGE_WAIT_DELAY_MS = 2000;

export const PIPELINE_STATUSES = ['QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_STAGES = [
  'SEARCH',
  'SOURCE_DISCOVERY',
  'COMPANY_PERSISTENCE',
  'WEBSITE_DISCOVERY',
  'ENRICHMENT',
  'DEEP_RESEARCH',
  'DECISION_MAKER_DISCOVERY',
  'CONTACT_QUALITY',
  'EVIDENCE',
  'CLASSIFICATION',
  'VERIFICATION',
  'DEDUPLICATION',
  'SCORING',
  'QUALIFICATION',
  'COMPLETED',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const WORK_STAGES = PIPELINE_STAGES.filter((stage) => stage !== 'COMPLETED');
export type WorkStage = (typeof WORK_STAGES)[number];

export const STAGE_PROGRESS_KEYS = {
  SEARCH: 'search',
  SOURCE_DISCOVERY: 'sourceDiscovery',
  COMPANY_PERSISTENCE: 'companyPersistence',
  WEBSITE_DISCOVERY: 'websiteDiscovery',
  ENRICHMENT: 'enrichment',
  DEEP_RESEARCH: 'deepResearch',
  DECISION_MAKER_DISCOVERY: 'decisionMakerDiscovery',
  CONTACT_QUALITY: 'contactQuality',
  EVIDENCE: 'evidence',
  CLASSIFICATION: 'classification',
  VERIFICATION: 'verification',
  DEDUPLICATION: 'deduplication',
  SCORING: 'scoring',
  QUALIFICATION: 'qualification',
} as const;

export type StageProgressKey = (typeof STAGE_PROGRESS_KEYS)[WorkStage];
export type StageState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export const PIPELINE_ERROR_CODES = [
  'TRANSIENT_PROVIDER_ERROR',
  'VALIDATION_ERROR',
  'CONFIGURATION_ERROR',
  'NOT_FOUND',
  'PERMISSION_ERROR',
  'INTERNAL_ERROR',
] as const;
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

export const TRACKED_QUEUES = {
  websiteDiscovery: 'company-enrichment-queue',
  enrichment: 'company-enrichment-queue',
  deepResearch: 'lead-research-queue',
  decisionMakerDiscovery: 'contact-discovery-queue',
  contactQuality: 'contact-quality-queue',
  classification: 'ai-classification-queue',
  verification: 'lead-verification-queue',
  deduplication: 'lead-deduplication-queue',
  scoring: 'lead-scoring-queue',
  qualification: 'lead-qualification-queue',
} as const;
