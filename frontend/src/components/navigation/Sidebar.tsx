import { NavLink } from 'react-router-dom';

const links = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/search/new', label: 'New Search' },
  { to: '/leads', label: 'Leads' },
  { to: '/search-history', label: 'Search History' },
  { to: '/research', label: 'Research' },
  { to: '/exports', label: 'Exports' },
  { to: '/settings', label: 'Settings' },
];

export function Sidebar({ collapsed, open, onNavigate }: { collapsed: boolean; open: boolean; onNavigate: () => void }) {
  return (
    <nav className="sidebar" data-collapsed={collapsed} data-open={open} aria-label="Primary">
      <p className="brand">{collapsed ? 'LP' : 'LeadPilot'}</p>
      {links.map((link) => (
        <NavLink key={link.to} to={link.to} onClick={onNavigate} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
          <span className="nav-label">{link.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
