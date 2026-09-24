import type { ReactNode } from 'react';
import { EmptyState } from '../feedback/States';
import { evidenceView } from '../../lib/evidence';
import type { EvidenceItem } from '../../types/api';
import { EvidenceCard } from './EvidenceCard';

export function EvidencePanel({ evidence, emptyAction }: { evidence: EvidenceItem[]; emptyAction?: ReactNode }) {
  if (!evidence.length) return <EmptyState title="No evidence available" detail="Evidence appears after research or verification stores a source." action={emptyAction} />;
  return (
    <div className="stack">
      {evidence.map((item, index) => <EvidenceCard key={item.id ?? `${index}`} item={evidenceView(item)} />)}
    </div>
  );
}
