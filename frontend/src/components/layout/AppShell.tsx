import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sidebar } from '../navigation/Sidebar';
import { TopBar } from './TopBar';

export function AppShell() {
  const location = useLocation();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(() => window.matchMedia('(max-width: 1023px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const apply = () => setDrawer(media.matches);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      {drawer && open ? <button type="button" className="backdrop" aria-label="Close navigation" onClick={() => setOpen(false)} /> : null}
      <Sidebar collapsed={!drawer && collapsed} open={!drawer || open} onNavigate={() => setOpen(false)} />
      <div className="workspace">
        <TopBar onMenu={() => (drawer ? setOpen(true) : setCollapsed((value) => !value))} />
        <main id="main">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduce ? 0 : 0.18 }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
