import type { PipelineView } from '../../types/api';
import { StatusBadge } from '../feedback/States';

const stages: Array<{ key: keyof PipelineView['stages']; label: string }> = [
  { key: 'sourceDiscovery', label: 'Discovery' },
  { key: 'companyPersistence', label: 'Companies saved' },
  { key: 'websiteDiscovery', label: 'Website discovery' },
  { key: 'enrichment', label: 'Enrichment' },
  { key: 'deepResearch', label: 'Website research' },
  { key: 'decisionMakerDiscovery', label: 'Decision makers' },
  { key: 'verification', label: 'Verification' },
  { key: 'classification', label: 'Classification' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'qualification', label: 'Qualification' },
];

export function PipelineProgress({ pipeline }: { pipeline: PipelineView }) {
  return (
    <section className="panel" aria-label="Search progress">
      <header className="panel-head">
        <h2>Pipeline</h2>
        <StatusBadge status={pipeline.status} />
      </header>
      <p>Current stage: {pipeline.currentStage}</p>
      <ol className="stage-list">
        {stages.map((stage) => (
          <li key={stage.key}>
            <span>{stage.label}</span>
            <StatusBadge status={pipeline.stages[stage.key]} />
          </li>
        ))}
      </ol>
      {pipeline.error ? <p role="alert">{pipeline.error.message.length > 180 ? 'This stage could not be completed.' : pipeline.error.message}</p> : null}
    </section>
  );
}
