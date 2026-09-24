import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pageItems, searchApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { EmptyState, ErrorState, Skeleton, StatusBadge } from '../components/feedback/States';
import { formatWhen } from '../lib/format';
import type { SearchExecutionSummary, SearchRecord } from '../types/api';

export function SearchHistoryPage() {
  const [searches, setSearches] = useState<SearchRecord[] | null>(null);
  const [executions, setExecutions] = useState<SearchExecutionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([searchApi.list(1), searchApi.executions(1)]).then(([searchPage, executionPage]) => {
      if (!active) return;
      setSearches(pageItems(searchPage));
      setExecutions(pageItems(executionPage));
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof ApiError ? reason.message : 'Unable to load search history. Please try again.');
    });
    return () => { active = false; };
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!searches || !executions) return <Skeleton rows={4} />;

  return (
    <section className="stack">
      <div className="panel">
        <h2>Saved searches</h2>
        {searches.length === 0 ? <EmptyState title="No searches yet" detail="Create a search to start discovery and research." /> : (
          <ul className="plain-list">
            {searches.map((search) => (
              <li key={search.id}>
                <Link to={`/search-history/${search.id}`}>{search.name}</Link>
                <StatusBadge status={search.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel">
        <h2>Executions</h2>
        {executions.length === 0 ? <EmptyState title="No searches yet" detail="Completed and running executions will be listed here." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Search</th><th>Status</th><th>Started</th><th>Completed</th><th>Companies</th><th>Qualified leads</th><th>Execution</th></tr></thead>
              <tbody>
                {executions.map((execution) => (
                  <tr key={execution.id}>
                    <td>{execution.userPrompt || 'Not Found'}</td>
                    <td><StatusBadge status={execution.status} /></td>
                    <td>{formatWhen(execution.createdAt)}</td>
                    <td>{formatWhen(execution.completedAt)}</td>
                    <td>{execution.companyCount}</td>
                    <td>{execution.qualifiedLeadCount}</td>
                    <td>{execution.searchId ? <Link to={`/search/${execution.searchId}/execution/${execution.id}`}>Open</Link> : 'Not Found'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
