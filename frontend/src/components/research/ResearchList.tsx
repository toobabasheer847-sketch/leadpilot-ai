import { formatWhen } from '../../lib/format';
import type { ResearchExecution } from '../../types/api';
import { EmptyState, StatusBadge } from '../feedback/States';

export function ResearchList({ companyName, executions }: { companyName: string; executions: ResearchExecution[] }) {
  if (!executions.length) return <EmptyState title="No active research" detail={`${companyName} has no research executions yet.`} />;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Research executions for {companyName}</caption>
        <thead>
          <tr>
            <th>Company</th>
            <th>Research ID</th>
            <th>Status</th>
            <th>Pages Processed</th>
            <th>Fields Extracted</th>
            <th>Fields Verified</th>
            <th>Conflicts</th>
            <th>Started</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((execution) => (
            <tr key={execution.id}>
              <td>{companyName}</td>
              <td>{execution.id}</td>
              <td><StatusBadge status={execution.status} /></td>
              <td>{execution.pagesProcessed}</td>
              <td>{execution.fieldsExtracted}</td>
              <td>{execution.fieldsVerified}</td>
              <td>{execution.conflictsFound}</td>
              <td>{formatWhen(execution.startedAt)}</td>
              <td>{formatWhen(execution.completedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
