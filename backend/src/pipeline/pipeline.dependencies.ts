/**
 * Phase M — Pipeline stage dependency graph (source of truth: runner + services).
 *
 * Sequential barriers (must wait):
 *   SEARCH → SOURCE_DISCOVERY → COMPANY_PERSISTENCE
 *     → WEBSITE_DISCOVERY / ENRICHMENT (same enrichment jobs)
 *     → [POST_ENRICHMENT_PARALLEL]
 *     → COMPLETENESS_RETRY (Phase O; in-runner bounded pass, not a UI stage)
 *     → CONTACT_QUALITY (needs contacts from decision-maker discovery)
 *     → EVIDENCE (barrier: all evidence writers finished)
 *     → [POST_EVIDENCE_PARALLEL]
 *     → DEDUPLICATION (uses verification status for phone/email confidence)
 *     → SCORING (needs classification + verification + evidence)
 *     → QUALIFICATION (last; all criteria evaluated)
 *
 * POST_ENRICHMENT_PARALLEL (independent after company + website enrichment):
 *   - DEEP_RESEARCH: company identity + preferred website; writes research evidence
 *   - EMPLOYEE_SIZE: company name/website; no deep-research / DM dependency
 *   - DECISION_MAKER_DISCOVERY: company identity + website; own crawl/search;
 *     does not consume deep-research outputs; never invents people
 *
 * POST_EVIDENCE_PARALLEL (independent after evidence barrier):
 *   - CLASSIFICATION: evidence rows only (not verification results)
 *   - VERIFICATION: company/contact fields + evidence (not classification)
 *
 * Intentionally sequential (real data deps):
 *   - CONTACT_QUALITY after decision makers exist
 *   - EVIDENCE after enrichment + deep research + DM (+ quality) writers
 *   - DEDUPLICATION after verification (phoneVerified / status boosts)
 *   - SCORING after classification + verification
 *   - QUALIFICATION after scoring and all required fields
 */

import type { StageProgressKey, WorkStage } from './pipeline.constants';

export type StageDependencyDoc = {
  stage: WorkStage;
  progressKey: StageProgressKey;
  inputs: string[];
  outputs: string[];
  dependsOnWebsiteDiscovery: boolean;
  dependsOnEnrichment: boolean;
  dependsOnDecisionMakers: boolean;
  dependsOnContacts: boolean;
  dependsOnEvidence: boolean;
  dependsOnVerification: boolean;
  dependsOnClassification: boolean;
  dependsOnScoring: boolean;
  canRunInParallelWith: WorkStage[];
  mustWaitFor: WorkStage[];
};

/** Stages dispatched together after enrichment settles. */
export const POST_ENRICHMENT_PARALLEL = ['deepResearch', 'employeeSize', 'decisionMakerDiscovery'] as const;
export type PostEnrichmentKey = (typeof POST_ENRICHMENT_PARALLEL)[number];

/** Stages dispatched together after the evidence barrier. */
export const POST_EVIDENCE_PARALLEL = ['classification', 'verification'] as const;
export type PostEvidenceKey = (typeof POST_EVIDENCE_PARALLEL)[number];

/** After post-enrichment parallel settles, the next sequential stage. */
export const AFTER_POST_ENRICHMENT: WorkStage = 'CONTACT_QUALITY';

/** After post-evidence parallel settles, the next sequential stage. */
export const AFTER_POST_EVIDENCE: WorkStage = 'DEDUPLICATION';

export const PIPELINE_STAGE_DEPENDENCIES: StageDependencyDoc[] = [
  {
    stage: 'SEARCH',
    progressKey: 'search',
    inputs: ['searchId', 'organizationId'],
    outputs: ['searchExecution'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: [],
  },
  {
    stage: 'SOURCE_DISCOVERY',
    progressKey: 'sourceDiscovery',
    inputs: ['searchExecution', 'SearchPlan'],
    outputs: ['discovered companies'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: ['SEARCH'],
  },
  {
    stage: 'COMPANY_PERSISTENCE',
    progressKey: 'companyPersistence',
    inputs: ['discovered companies'],
    outputs: ['persisted company rows'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: ['SOURCE_DISCOVERY'],
  },
  {
    stage: 'WEBSITE_DISCOVERY',
    progressKey: 'websiteDiscovery',
    inputs: ['persisted companies'],
    outputs: ['website URL', 'website evidence'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['ENRICHMENT'],
    mustWaitFor: ['COMPANY_PERSISTENCE'],
  },
  {
    stage: 'ENRICHMENT',
    progressKey: 'enrichment',
    inputs: ['website discovery jobs (shared)'],
    outputs: ['company emails', 'company socials', 'enrichment evidence'],
    dependsOnWebsiteDiscovery: true,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['WEBSITE_DISCOVERY'],
    mustWaitFor: ['COMPANY_PERSISTENCE'],
  },
  {
    stage: 'DEEP_RESEARCH',
    progressKey: 'deepResearch',
    inputs: ['company identity', 'website when available'],
    outputs: ['research evidence', 'page excerpts'],
    dependsOnWebsiteDiscovery: true,
    dependsOnEnrichment: true,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['EMPLOYEE_SIZE', 'DECISION_MAKER_DISCOVERY'],
    mustWaitFor: ['ENRICHMENT'],
  },
  {
    stage: 'EMPLOYEE_SIZE',
    progressKey: 'employeeSize',
    inputs: ['company name/website', 'numeric size request'],
    outputs: ['employeeCount / employeeRange'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: true,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['DEEP_RESEARCH', 'DECISION_MAKER_DISCOVERY'],
    mustWaitFor: ['ENRICHMENT'],
  },
  {
    stage: 'DECISION_MAKER_DISCOVERY',
    progressKey: 'decisionMakerDiscovery',
    inputs: ['company identity', 'website', 'plan roles'],
    outputs: ['contacts', 'person evidence'],
    dependsOnWebsiteDiscovery: true,
    dependsOnEnrichment: true,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['DEEP_RESEARCH', 'EMPLOYEE_SIZE'],
    mustWaitFor: ['ENRICHMENT'],
  },
  {
    stage: 'CONTACT_QUALITY',
    progressKey: 'contactQuality',
    inputs: ['contacts', 'target roles'],
    outputs: ['contact quality scores'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: true,
    dependsOnContacts: true,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: ['DECISION_MAKER_DISCOVERY'],
  },
  {
    stage: 'EVIDENCE',
    progressKey: 'evidence',
    inputs: ['all prior evidence writers finished'],
    outputs: ['evidenceCollected counter'],
    dependsOnWebsiteDiscovery: true,
    dependsOnEnrichment: true,
    dependsOnDecisionMakers: true,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: ['ENRICHMENT', 'DEEP_RESEARCH', 'DECISION_MAKER_DISCOVERY', 'CONTACT_QUALITY'],
  },
  {
    stage: 'CLASSIFICATION',
    progressKey: 'classification',
    inputs: ['lead evidence rows'],
    outputs: ['lead classification decision'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: true,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['VERIFICATION'],
    mustWaitFor: ['EVIDENCE'],
  },
  {
    stage: 'VERIFICATION',
    progressKey: 'verification',
    inputs: ['company/contact fields', 'evidence'],
    outputs: ['field verification statuses'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: true,
    dependsOnDecisionMakers: false,
    dependsOnContacts: true,
    dependsOnEvidence: true,
    dependsOnVerification: false,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: ['CLASSIFICATION'],
    mustWaitFor: ['EVIDENCE'],
  },
  {
    stage: 'DEDUPLICATION',
    progressKey: 'deduplication',
    inputs: ['company/contact identity', 'verification status'],
    outputs: ['duplicate merges'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: true,
    dependsOnEvidence: false,
    dependsOnVerification: true,
    dependsOnClassification: false,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: ['VERIFICATION'],
  },
  {
    stage: 'SCORING',
    progressKey: 'scoring',
    inputs: ['classification', 'verification', 'evidence', 'contacts'],
    outputs: ['lead score'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: true,
    dependsOnEvidence: true,
    dependsOnVerification: true,
    dependsOnClassification: true,
    dependsOnScoring: false,
    canRunInParallelWith: [],
    mustWaitFor: ['CLASSIFICATION', 'VERIFICATION'],
  },
  {
    stage: 'QUALIFICATION',
    progressKey: 'qualification',
    inputs: ['score', 'required fields', 'verification', 'exclusions'],
    outputs: ['QUALIFIED / NOT_QUALIFIED / NEEDS_REVIEW'],
    dependsOnWebsiteDiscovery: false,
    dependsOnEnrichment: false,
    dependsOnDecisionMakers: false,
    dependsOnContacts: false,
    dependsOnEvidence: false,
    dependsOnVerification: true,
    dependsOnClassification: false,
    dependsOnScoring: true,
    canRunInParallelWith: [],
    mustWaitFor: ['SCORING'],
  },
];

export function dependencyFor(stage: WorkStage): StageDependencyDoc | undefined {
  return PIPELINE_STAGE_DEPENDENCIES.find((item) => item.stage === stage);
}
