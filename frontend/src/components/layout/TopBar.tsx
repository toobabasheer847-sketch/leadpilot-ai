import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/session';
import { useTheme } from '../../theme/theme';

const titles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/search/new': 'New Search',
  '/leads': 'Leads',
  '/search-history': 'Search History',
  '/research': 'Research',
  '/exports': 'Exports',
  '/settings': 'Settings',
};

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useAuth();
  const { choice, cycle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const title = titles[location.pathname] ?? (location.pathname.startsWith('/leads/') ? 'Company' : location.pathname.includes('/execution/') ? 'Search progress' : location.pathname.startsWith('/search-history/') ? 'Search progress' : 'LeadPilot');

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <header className="topbar">
      <button type="button" className="menu-button" aria-label="Open navigation" onClick={onMenu}>Menu</button>
      <div>
        <h1>{title}</h1>
        <p className="status-line">{user?.organization.name ?? 'Organization'} · {user?.role ?? 'Signed in'}</p>
      </div>
      <form className="top-search" onSubmit={(event) => { event.preventDefault(); navigate(query.trim() ? `/leads?search=${encodeURIComponent(query.trim())}` : '/leads'); }}>
        <label htmlFor="global-search">Find leads</label>
        <input id="global-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search leads" />
      </form>
      <button type="button" className="ghost" onClick={cycle} aria-label={`Theme ${choice}. Switch theme.`}>Theme: {choice}</button>
      <div className="user-menu">
        <button type="button" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}>
          {user?.name ?? 'Account'}
        </button>
        {menuOpen ? (
          <div role="menu" className="menu-panel">
            <p>{user?.email}</p>
            <Link to="/settings" role="menuitem">Settings</Link>
            <button type="button" role="menuitem" onClick={logout}>Log out</button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
