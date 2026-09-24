import { motion, useReducedMotion } from 'framer-motion';
import { EmptyState, StatusBadge } from '../feedback/States';
import { businessValue } from '../../lib/format';
import type { VerificationConflict } from '../../types/api';
import { ExternalLink } from './ExternalLink';

export function ConflictPanel({ conflicts }: { conflicts: VerificationConflict[] }) {
  const reduce = useReducedMotion();
  if (!conflicts.length) return <EmptyState title="No conflicts reported" detail="Conflicts appear when stored sources disagree and the backend marks them for review." />;
  return (
    <div className="stack">
      {conflicts.map((conflict) => (
        <motion.article key={conflict.id} className="panel conflict" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h3>Conflict detected</h3>
          <p>Field {conflict.fieldName}</p>
          <p>Source A {businessValue(conflict.valueA)}</p>
          <p>{conflict.sourceTypeA ? businessValue(conflict.sourceTypeA) : null} <ExternalLink href={conflict.sourceUrlA} /></p>
          {conflict.evidenceExcerptA ? <p>{conflict.evidenceExcerptA}</p> : null}
          <p>Source B {businessValue(conflict.valueB)}</p>
          <p>{conflict.sourceTypeB ? businessValue(conflict.sourceTypeB) : null} <ExternalLink href={conflict.sourceUrlB} /></p>
          {conflict.evidenceExcerptB ? <p>{conflict.evidenceExcerptB}</p> : null}
          <p>Status <StatusBadge status={conflict.status} /></p>
        </motion.article>
      ))}
    </div>
  );
}
