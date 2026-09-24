import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { exportApi, leadApi, pageTotal, searchApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { ErrorState, Skeleton } from '../components/feedback/States';
import { metricLabel } from '../lib/format';

export function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searches, setSearches] = useState<number | null>(null);
  const [leads, setLeads] = useState<number | null>(null);
  const [qualified, setQualified] = useState<number | null>(null);
  const [exportsTotal, setExportsTotal] = useState<number | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      searchApi.list(1),
      leadApi.list({ page: 1, limit: 1 }),
      leadApi.list({ page: 1, limit: 1, qualificationStatus: 'QUALIFIED' }),
      exportApi.list(1),
    ]).then(([searchPage, leadPage, qualifiedPage, exportPage]) => {
      setSearches(pageTotal(searchPage));
      setLeads(pageTotal(leadPage));
      setQualified(pageTotal(qualifiedPage));
      setExportsTotal(pageTotal(exportPage));
    }).catch((reason: unknown) => {
      setError(reason instanceof ApiError ? reason.message : 'Unable to load the dashboard. Please try again.');
    }).finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <section className="stack">
      <div className="metric-grid">
        <Metric label="Searches" value={metricLabel(searches)} loading={loading} href="/search-history" />
        <Metric label="Total leads" value={metricLabel(leads)} loading={loading} href="/leads" />
        <Metric label="Qualified leads" value={metricLabel(qualified)} loading={loading} href="/leads?qualificationStatus=QUALIFIED" />
        <Metric label="Research running" value="Not available" loading={false} href="/research" />
        <Metric label="Exports" value={metricLabel(exportsTotal)} loading={loading} href="/exports" />
      </div>
      <p className="muted">Research running is not available because the API does not provide an organization-wide count.</p>
    </section>
  );
}

function Metric({ label, value, loading, href }: { label: string; value: string; loading: boolean; href: string }) {
  return (
    <Link className="metric" to={href}>
      <p>{label}</p>
      {loading ? <Skeleton rows={1} /> : <strong>{value}</strong>}
    </Link>
  );
}
