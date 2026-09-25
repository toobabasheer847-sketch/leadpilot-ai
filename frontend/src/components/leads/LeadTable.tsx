import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { businessValue, formatWhen } from '../../lib/format';
import { collectSocialLinks } from '../../lib/social';
import type { LeadRecord, LeadSortBy } from '../../types/api';
import { EmptyState } from '../feedback/States';
import { ExternalLink } from '../company/ExternalLink';
import { LeadScoreBadge } from './LeadScoreBadge';
import { LeadStatusBadge } from './LeadStatusBadge';

function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  return narrow;
}

export function LeadTable({ leads, selected = new Set(), onToggle = () => undefined, onTogglePage = () => undefined, sortBy = 'createdAt', sortOrder = 'desc', onSort = () => undefined }: {
  leads: LeadRecord[];
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onTogglePage?: (ids: string[], checked: boolean) => void;
  sortBy?: LeadSortBy;
  sortOrder?: 'asc' | 'desc';
  onSort?: (column: LeadSortBy) => void;
}) {
  const narrow = useNarrowScreen();
  if (!leads.length) return <EmptyState title="No leads found" detail="Leads appear here after a search discovers companies." />;
  const ids = leads.map((lead) => lead.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  if (narrow) {
    return (
      <div className="lead-cards">
        {leads.map((lead) => (
          <article key={lead.id} className="panel lead-card">
            <label>
              <input type="checkbox" aria-label={`Select ${businessValue(lead.company.name)}`} checked={selected.has(lead.id)} onChange={() => onToggle(lead.id)} />
              {' '}Select
            </label>
            {leadCells(lead).map((cell) => <p key={cell.key}>{cell.node}</p>)}
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="table-wrap lead-table">
      <table>
        <caption className="sr-only">Leads</caption>
        <thead>
          <tr>
            <th className="check-cell">
              <input type="checkbox" aria-label="Select all leads on this page" checked={allSelected} onChange={(event) => onTogglePage(ids, event.target.checked)} />
            </th>
            <SortHeader label="Company" column="companyName" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
            <th>Website</th>
            <th>Address</th>
            <th>City</th>
            <th>State</th>
            <th>ZIP</th>
            <th>Company size</th>
            <th>Investor type</th>
            <th>Decision maker</th>
            <th>Title</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Company social</th>
            <th>Decision maker social</th>
            <th>Verification</th>
            <SortHeader label="Quality" column="score" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
            <th>Qualification</th>
            <SortHeader label="Last verified" column="lastVerifiedAt" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>
                <input type="checkbox" aria-label={`Select ${businessValue(lead.company.name)}`} checked={selected.has(lead.id)} onChange={() => onToggle(lead.id)} />
              </td>
              {leadCells(lead).map((cell) => <td key={cell.key}>{cell.node}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({ label, column, sortBy, sortOrder, onSort }: {
  label: string;
  column: LeadSortBy;
  sortBy: LeadSortBy;
  sortOrder: 'asc' | 'desc';
  onSort: (column: LeadSortBy) => void;
}) {
  const active = sortBy === column;
  return (
    <th aria-sort={active ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => onSort(column)}>{label}{active ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}</button>
    </th>
  );
}

function companySizeLabel(lead: LeadRecord) {
  const value = lead.company.companySize;
  const shown = value == null || value === '' ? null : String(value);
  if (lead.company.companySizeStatus === 'MATCHED') return shown ? `MATCHED 1-50 (${shown})` : 'MATCHED 1-50';
  if (lead.company.companySizeStatus === 'OUTSIDE_RANGE') return shown ? `OUTSIDE RANGE (${shown})` : 'OUTSIDE RANGE';
  if (lead.company.companySizeStatus === 'UNKNOWN' || shown == null) return 'UNKNOWN';
  return shown;
}

function socialLabel(links: Array<{ platform: string }>) {
  if (!links.length) return businessValue(null);
  return links.map((link) => link.platform).join(', ');
}

function leadCells(lead: LeadRecord): Array<{ key: string; node: ReactNode }> {
  return [
    { key: 'company', node: <Link to={`/leads/${lead.id}`}><strong>{businessValue(lead.company.name)}</strong></Link> },
    { key: 'website', node: <ExternalLink href={lead.company.website} /> },
    { key: 'address', node: businessValue(lead.company.location?.address) },
    { key: 'city', node: businessValue(lead.company.location?.city) },
    { key: 'state', node: businessValue(lead.company.location?.state) },
    { key: 'zip', node: businessValue(lead.company.location?.zipCode) },
    { key: 'size', node: companySizeLabel(lead) },
    { key: 'investor', node: businessValue(lead.company.investorType) },
    { key: 'person', node: businessValue(lead.contact?.name) },
    { key: 'title', node: businessValue(lead.contact?.title) },
    { key: 'email', node: businessValue(lead.contact?.email) },
    { key: 'phone', node: businessValue(lead.company.phone ?? lead.contact?.phone) },
    { key: 'companySocial', node: socialLabel(collectSocialLinks({ rows: lead.socialProfiles })) },
    { key: 'personSocial', node: socialLabel(collectSocialLinks({ contact: lead.contact ? { linkedinUrl: lead.contact.linkedin ?? null, facebookUrl: lead.contact.facebook ?? null, instagramUrl: lead.contact.instagram ?? null, youtubeUrl: lead.contact.youtube ?? null } : null })) },
    { key: 'verification', node: <LeadStatusBadge status={lead.verification?.status} /> },
    { key: 'score', node: <LeadScoreBadge score={lead.score} /> },
    { key: 'qualification', node: <LeadStatusBadge status={lead.qualification?.status} /> },
    { key: 'verified', node: formatWhen(lead.lastVerifiedAt) },
  ];
}
