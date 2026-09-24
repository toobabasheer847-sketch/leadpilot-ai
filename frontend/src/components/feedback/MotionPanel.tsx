import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export function MotionPanel({ children, className = 'panel' }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.section className={className} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      {children}
    </motion.section>
  );
}
