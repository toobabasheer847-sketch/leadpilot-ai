import { useEffect, useState } from 'react';
import { leadApi, pageItems, researchApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { EmptyState, ErrorState, Skeleton } from '../components/feedback/States';
import { ResearchList } from '../components/research/ResearchList';
import { useToasts } from '../feedback/toasts';
import type { LeadRecord, ResearchExecution } from '../types/api';

export function ResearchPage() {
  const { notify } = useToasts();
  const [companies, setCompanies] = useState<LeadRecord[] | null>(null);
  const [companyId, setCompanyId] = useState('');
  const [executions, setExecutions] = useState<ResearchExecution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    leadApi.list({ page: 1, limit: 50 }).then((result) => {
      if (!active) return;
      const rows = pageItems(result);
      setCompanies(rows);
      setCompanyId((current) => current || rows[0]?.company.id || '');
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof ApiError ? reason.message : 'Unable to load companies for research.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!companyId) return;
    let active = true;
    let timer = 0;
    const load = () => {
      researchApi.list(companyId).then((rows) => {
        if (!active) return;
        const list = Array.isArray(rows) ? rows : [];
        setExecutions(list);
        if (list.some((row) => row.status === 'QUEUED' || row.status === 'RUNNING')) timer = window.setTimeout(load, 4000);
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof ApiError ? reason.message : 'Unable to load research. Please try again.');
      });
    };
    setExecutions(null);
    load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [companyId]);

  const company = companies?.find((item) => item.company.id === companyId);

  async function start() {
    if (!companyId) return;
    setBusy(true);
    try {
      const started = await researchApi.start(companyId);
      notify(started.status === 'FAILED' ? 'error' : 'success', started.status === 'FAILED' ? 'Unable to start research' : 'Research started');
      const listed = await researchApi.list(companyId);
      setExecutions(Array.isArray(listed) ? listed : []);
    } catch (reason) {
      notify('error', reason instanceof ApiError ? reason.message : 'Unable to start research');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!companies) return <Skeleton rows={4} />;
  if (!companies.length) return <EmptyState title="No active research" detail="Research can start after a company has been discovered." />;

  return (
    <section className="stack">
      <div className="actions">
        <label>Company
          <select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
            {companies.map((item) => <option key={item.company.id} value={item.company.id}>{item.company.name || 'Not Found'}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy || !companyId} onClick={() => void start()}>{busy ? 'Starting research' : 'Start research'}</button>
      </div>
      {executions === null ? <Skeleton rows={4} /> : <ResearchList companyName={company?.company.name || 'Not Found'} executions={executions} />}
    </section>
  );
}
