import { citedEvidence } from '../../lib/evidence';
import type { EvidenceItem, EvidenceReference } from '../../types/api';
import { EmptyState } from '../feedback/States';
import { businessValue, formatWhen } from '../../lib/format';
import { ExternalLink } from './ExternalLink';

export function ClassificationEvidence({ references, evidence }: { references: EvidenceReference[] | undefined; evidence: EvidenceItem[] }) {
  const items = citedEvidence(references, evidence);
  if (!items.length) return <EmptyState title="No evidence available" detail="Classification evidence appears when the backend cites a stored source." />;
  return (
    <ol className="plain-list">
      {items.map((item, index) => (
        <li key={`${item.sourceUrl ?? 'source'}-${index}`}>
          <div>
            <strong>Evidence #{index + 1}</strong>
            <p>Source {businessValue(item.sourceType)}</p>
            <p>URL <ExternalLink href={item.sourceUrl} /></p>
            <p>Excerpt {businessValue(item.excerpt)}</p>
            <p>Type {businessValue(item.evidenceType)}</p>
            <p>Retrieved {formatWhen(item.retrievedAt)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
