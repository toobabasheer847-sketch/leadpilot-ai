import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

export function ConfirmDialog({ title, message, confirmLabel, busy, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      <motion.div className="dialog-backdrop" role="presentation" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel}>
        <motion.div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="dialog" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} onClick={(event) => event.stopPropagation()}>
          <h2 id="confirm-title">{title}</h2>
          <p>{message}</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={onConfirm}>{busy ? 'Sending...' : confirmLabel}</button>
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
