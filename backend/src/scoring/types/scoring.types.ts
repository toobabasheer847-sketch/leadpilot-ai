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
  /** Explicit list of fields with SUPPORTED/VERIFIED evidence for explainability. */
  verifiedEvidence: Array<{ field: string; status: string; evidenceId?: string | null }>;
  /** Explicit list of open field conflicts / needs-review items. */
  conflicts: Array<{ field: string; status: string; evidenceId?: string | null }>;
}

export interface ScoringJobData {
  companyId: string;
  contactId: string | null;
  organizationId: string;
  searchExecutionId: string | null;
  force: boolean;
  idempotencyKey: string;
}
