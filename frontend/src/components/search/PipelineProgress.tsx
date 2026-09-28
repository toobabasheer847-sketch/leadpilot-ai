import type { PipelineView, StageState } from '../../types/api';
import { StatusBadge } from '../feedback/States';

const labels: Record<string, string> = {
  SEARCH: 'Search started',
  DISCOVERY: 'Discovery',
  COMPANY_PERSISTENCE: 'Companies saved',
  WEBSITE_DISCOVERY: 'Website discovery',
  ENRICHMENT: 'Enrichment',
  DEEP_RESEARCH: 'Website research',
  EMPLOYEE_SIZE: 'Employee size',
  DECISION_MAKER_DISCOVERY: 'Decision makers',
  CONTACT_QUALITY: 'Contact quality',
  EVIDENCE: 'Evidence',
  CLASSIFICATION: 'Classification',
  VERIFICATION: 'Verification',
  DEDUPLICATION: 'Deduplication',
  SCORING: 'Scoring',
  QUALIFICATION: 'Qualification',
};

const counterLabels: Array<[keyof PipelineView['counters'], string]> = [
  ['requestedCount', 'Requested count'],
  ['companiesDiscovered', 'Companies discovered'],
  ['companiesPersisted', 'Companies persisted'],
  ['discoveryShortfall', 'Not found within budget'],
  ['companySizeRequested', 'Company size requested'],
  ['websitesFound', 'Websites found'],
  ['websitesNotFound', 'Websites not found'],
  ['companySizeFound', 'Company-size found'],
  ['companySizeUnknown', 'Company-size unknown'],
  ['decisionMakersFound', 'Decision makers found'],
  ['decisionMakerEmailsFound', 'Decision-maker emails found'],
  ['companyEmailsFound', 'Company emails found'],
  ['socialProfilesFound', 'Social profiles found'],
  ['qualifiedLeads', 'Qualified leads'],
  ['needsReview', 'Needs review'],
  ['rejected', 'Rejected'],
  ['evidenceCollected', 'Evidence collected'],
  ['conflictsFound', 'Conflicts'],
  ['duplicatesFound', 'Duplicates'],
];

export function PipelineProgress({ pipeline }: { pipeline: PipelineView }) {
  const rows = pipeline.stageList.filter((stage) => stage.name !== 'COMPLETED');
  return (
    <div className="stack">
      <ol className="pipeline-list">
        {rows.map((stage) => (
          <li key={stage.name}>
            <span className={`pipeline-mark ${markClass(stage.status)}`} aria-hidden="true">{mark(stage.status)}</span>
            <strong>{labels[stage.name] ?? stage.name}</strong>
            <StatusBadge status={stage.status} />
          </li>
        ))}
      </ol>
      <dl className="stat-grid">
        {counterLabels.map(([key, label]) => {
          const value = pipeline.counters[key];
          if (value === null || value === undefined) return null;
          const shown = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
          return <div key={key}><dt>{label}</dt><dd>{shown}</dd></div>;
        })}
      </dl>
      {pipeline.counters.discoveryShortfall && pipeline.counters.requestedCount != null && pipeline.counters.companiesPersisted != null ? (
        <p>Found {pipeline.counters.companiesPersisted} credible companies out of {pipeline.counters.requestedCount} requested. Missing companies were not invented.</p>
      ) : null}
    </div>
  );
}

function mark(status: StageState) {
  if (status === 'COMPLETED') return '✓';
  if (status === 'RUNNING') return '●';
  if (status === 'FAILED' || status === 'PARTIAL') return '!';
  return '○';
}

function markClass(status: StageState) {
  if (status === 'COMPLETED') return 'done';
  if (status === 'RUNNING') return 'active';
  if (status === 'FAILED' || status === 'PARTIAL') return 'issue';
  return 'waiting';
}
