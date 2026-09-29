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
  ['countIntent', 'Count intent'],
  ['companiesDiscovered', 'Companies discovered'],
  ['companiesPersisted', 'Companies persisted'],
  ['discoveryShortfall', 'Discovery shortfall'],
  ['discoveryRejected', 'Candidates rejected'],
  ['discoveryDuplicatesRemoved', 'Duplicates removed'],
  ['discoveryProviderQueries', 'Provider queries'],
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
  ['qualifiedShortfall', 'Qualified shortfall'],
  ['needsReview', 'Needs review'],
  ['rejected', 'Rejected'],
  ['evidenceCollected', 'Evidence collected'],
  ['conflictsFound', 'Conflicts'],
  ['duplicatesFound', 'Duplicates'],
];

export function PipelineProgress({ pipeline }: { pipeline: PipelineView }) {
  const rows = pipeline.stageList.filter((stage) => stage.name !== 'COMPLETED');
  const requested = pipeline.counters.requestedCount;
  const persisted = pipeline.counters.companiesPersisted;
  const qualified = pipeline.counters.qualifiedLeads;
  const discoveryShortfall = pipeline.counters.discoveryShortfall;
  const qualifiedShortfall = pipeline.counters.qualifiedShortfall;
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
      {discoveryShortfall && requested != null && persisted != null ? (
        <p>Found {persisted} credible companies out of {requested} requested. Missing companies were not invented.</p>
      ) : null}
      {qualifiedShortfall && requested != null && qualified != null ? (
        <p>Qualified {qualified} of {requested} requested. Requested count is not a promise of qualified leads.</p>
      ) : null}
    </div>
  );
}

function mark(status: StageState) {
  if (status === 'COMPLETED' || status === 'SKIPPED') return '✓';
  if (status === 'RUNNING') return '●';
  if (status === 'FAILED' || status === 'PARTIAL') return '!';
  return '○';
}

function markClass(status: StageState) {
  if (status === 'COMPLETED' || status === 'SKIPPED') return 'done';
  if (status === 'RUNNING') return 'active';
  if (status === 'FAILED' || status === 'PARTIAL') return 'issue';
  return 'waiting';
}
