import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { businessValue, formatWhen } from '../../lib/format';
import type { EvidenceView } from '../../lib/evidence';
import { ExternalLink } from './ExternalLink';

export function EvidenceCard({ item }: { item: EvidenceView }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  return (
    <article className="evidence-card">
      <button type="button" className="ghost evidence-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {businessValue(item.sourceType)} · {businessValue(item.evidenceType)}
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }} className="evidence-body">
            <p><ExternalLink href={item.sourceUrl} /></p>
            <p>{businessValue(item.excerpt)}</p>
            <p className="muted">Retrieved {formatWhen(item.retrievedAt)}</p>
            <p className="muted">Relationship {businessValue(item.relationship)}</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </article>
  );
}
