import { businessValue, locationLabel } from '../../lib/format';
import type { LeadRecord } from '../../types/api';
import { EmptyState, StatusBadge } from '../feedback/States';

export function LeadTable({ leads }: { leads: LeadRecord[] }) {
  if (!leads.length) return <EmptyState title="No leads found" detail="Leads appear here after a search discovers companies." />;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Leads</caption>
        <thead>
          <tr>
            <th>Company</th>
            <th>Location</th>
            <th>Investor Type</th>
            <th>Decision Maker</th>
            <th>Title</th>
            <th>Email</th>
            <th>Verification</th>
            <th>Quality</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>
                <strong>{businessValue(lead.company.name)}</strong>
                <small>{businessValue(lead.company.website)}</small>
                <small>{Array.isArray(lead.evidence) ? `${lead.evidence.length} sources` : 'Not available'}</small>
              </td>
              <td>{locationLabel(lead.company.location)}</td>
              <td>{businessValue(lead.company.investorType)}</td>
              <td>{businessValue(lead.contact?.name)}</td>
              <td>{businessValue(lead.contact?.title)}</td>
              <td>{businessValue(lead.contact?.email)}</td>
              <td><StatusBadge status={lead.verification?.status} /></td>
              <td>{lead.score ? `${lead.score.value}${lead.score.band ? ` · ${lead.score.band}` : ''}` : 'Not available'}</td>
              <td><StatusBadge status={lead.qualification?.status ?? lead.classification?.decision} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
