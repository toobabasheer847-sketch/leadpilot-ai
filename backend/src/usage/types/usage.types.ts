export type UsageOperation = 'SEARCH' | 'DISCOVERY' | 'WEBSITE_FETCH' | 'CONTACT_DISCOVERY' | 'SOCIAL_DISCOVERY' | 'ENRICHMENT' | 'AI_CLASSIFICATION' | 'VERIFICATION' | 'EXPORT';
export type CostStatus = 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN';

export interface UsageRecordInput {
  organizationId: string;
  userId?: string | null;
  provider?: string | null;
  operation: UsageOperation;
  resourceType?: string | null;
  resourceId?: string | null;
  units?: number;
  status?: string;
  estimatedCost?: number | null;
  costStatus?: CostStatus;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UsageLimits {
  requestsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
  aiRequestsPerMinute: number;
  aiRequestsPerDay: number;
  dailySearchLimit: number;
  dailyExportLimit: number;
  dailyAiLimit: number;
  maxLeadsPerSearch: number;
  maxExportRows: number;
}
