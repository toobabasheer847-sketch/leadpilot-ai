export type ScoreBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export interface ScoreSignal {
  name: string;
  value: string | number | boolean;
  points: number;
  reason: string;
  evidenceId?: string;
  evidenceAge?: number;
  freshnessStatus?: 'FRESH' | 'AGING' | 'STALE' | 'NOT_AVAILABLE';
}

export interface ScoreBreakdown {
  total: number;
  band: ScoreBand;
  version: string;
  signals: ScoreSignal[];
  availableFields: number;
  expectedFields: number;
  completenessPercentage: number;
  sourceTypes: string[];
}

export interface ScoringJobData {
  companyId: string;
  contactId: string | null;
  organizationId: string;
  searchExecutionId: string | null;
  force: boolean;
  idempotencyKey: string;
}
