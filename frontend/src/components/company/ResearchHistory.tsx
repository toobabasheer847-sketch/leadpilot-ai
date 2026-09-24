import type { ReactNode } from 'react';
import { EmptyState, StatusBadge } from '../feedback/States';
import { formatWhen } from '../../lib/format';
import type { ResearchExecution } from '../../types/api';

export function ResearchHistory({ rows, action }: { rows: ResearchExecution[]; action?: ReactNode }) {
  if (!rows.length) return <EmptyState title="No research history" detail="Research runs for this company will be listed here." action={action} />;
  return (
    <div className="stack">
      {action}
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Research history</caption>
          <thead>
            <tr>
              <th>Research ID</th>
              <th>Status</th>
              <th>Started</th>
              <th>Completed</th>
              <th>Pages processed</th>
              <th>Evidence found</th>
              <th>Fields extracted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td><StatusBadge status={row.status} /></td>
                <td>{formatWhen(row.startedAt)}</td>
                <td>{formatWhen(row.completedAt)}</td>
                <td>{row.pagesProcessed}</td>
                <td>Not available</td>
                <td>{row.fieldsExtracted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
