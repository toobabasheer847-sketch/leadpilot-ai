import type { PipelineView, StageState } from '../../types/api';
import { StatusBadge } from '../feedback/States';

const labels: Record<string, string> = {
  SEARCH: 'Search started',
  DISCOVERY: 'Discovery',
  COMPANY_PERSISTENCE: 'Companies saved',
  WEBSITE_DISCOVERY: 'Website discovery',
  ENRICHMENT: 'Enrichment',
  DEEP_RESEARCH: 'Website research',
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
  ['companiesDiscovered', 'Companies discovered'],
  ['companiesProcessed', 'Companies processed'],
  ['websitesResearched', 'Websites researched'],
  ['decisionMakersFound', 'Decision makers found'],
  ['contactsFound', 'Contacts found'],
  ['evidenceCollected', 'Evidence collected'],
  ['verifiedFields', 'Verified fields'],
  ['conflictsFound', 'Conflicts'],
  ['duplicatesFound', 'Duplicates'],
  ['qualifiedLeads', 'Qualified leads'],
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
          return <div key={key}><dt>{label}</dt><dd>{value}</dd></div>;
        })}
      </dl>
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
