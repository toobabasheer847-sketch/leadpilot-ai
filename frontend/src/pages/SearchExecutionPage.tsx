import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { exportApi, pipelineApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { PipelineProgress } from '../components/search/PipelineProgress';
import { ErrorState, Skeleton, StatusBadge } from '../components/feedback/States';
import { ConfirmDialog } from '../components/feedback/ConfirmDialog';
import { useToasts } from '../feedback/toasts';
import type { PipelineView } from '../types/api';

export function SearchExecutionPage() {
  const { searchId = '', executionId = '' } = useParams();
  const navigate = useNavigate();
  const { notify } = useToasts();
  const [pipeline, setPipeline] = useState<PipelineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!executionId) return undefined;
    let active = true;
    let timer = 0;
    const load = () => {
      pipelineApi.execution(executionId).then((next) => {
        if (!active) return;
        if (next.searchId !== searchId) {
          setError('This execution does not belong to the requested search.');
          return;
        }
        setPipeline(next);
        setError(null);
        if (next.status === 'QUEUED' || next.status === 'RUNNING') timer = window.setTimeout(load, 4000);
      }).catch((caught: unknown) => {
        if (active) setError(caught instanceof ApiError ? caught.message : 'Unable to load pipeline status.');
      });
    };
    load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [executionId, searchId]);

  async function cancel() {
    setBusy(true);
    try {
      setPipeline(await pipelineApi.cancelExecution(executionId));
      setConfirmCancel(false);
      notify('success', 'Search cancelled.');
    } catch (caught) {
      notify('error', caught instanceof ApiError ? caught.message : 'Cancel failed.');
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      const next = await pipelineApi.execute(searchId);
      if (next.executionId) navigate(`/search/${searchId}/execution/${next.executionId}`);
    } catch (caught) {
      notify('error', caught instanceof ApiError ? caught.message : 'Search could not be started.');
      setBusy(false);
    }
  }

  async function exportLeads() {
    if (!pipeline?.searchExecutionId) return;
    try {
      await exportApi.create('csv', { searchExecutionId: pipeline.searchExecutionId });
      notify('success', 'Export queued. Open Exports to download it.');
    } catch (caught) {
      notify('error', caught instanceof ApiError ? caught.message : 'Export failed.');
    }
  }

  const finished = pipeline?.status === 'COMPLETED' || pipeline?.status === 'PARTIAL';

  return (
    <section className="stack">
      <div className="panel">
        <h2>{heading(pipeline)}</h2>
        {pipeline ? <StatusBadge status={pipeline.status} /> : null}
      </div>
      {error ? <ErrorState message={error} /> : null}
      {!pipeline && !error ? <Skeleton rows={4} /> : null}
      {pipeline ? (
        <>
          <div className="panel">
            <PipelineProgress pipeline={pipeline} />
            {pipeline.status === 'PARTIAL' ? <p>Search completed with some issues.</p> : null}
            {pipeline.failures.length ? (
              <ul className="plain-list">
                {pipeline.failures.map((failure) => <li key={`${failure.stage}-${failure.message}`}>{failure.stage}: {failure.message}</li>)}
              </ul>
            ) : null}
            {pipeline.status === 'FAILED' ? <p role="alert">{pipeline.error?.message ?? 'Search could not be completed.'}</p> : null}
          </div>
          <div className="actions">
            {pipeline.searchExecutionId && finished ? <Link to={`/leads?searchExecutionId=${pipeline.searchExecutionId}`}>View leads</Link> : null}
            <Link to={`/search-history/${searchId}`}>View search</Link>
            {pipeline.searchExecutionId && finished ? <button type="button" className="secondary" onClick={() => void exportLeads()}>Export leads</button> : null}
            {pipeline.status === 'QUEUED' || pipeline.status === 'RUNNING' ? <button type="button" className="secondary" onClick={() => setConfirmCancel(true)}>Cancel search</button> : null}
            {pipeline.status === 'FAILED' || pipeline.status === 'PARTIAL' || pipeline.status === 'CANCELLED' ? <button type="button" disabled={busy} onClick={() => void retry()}>Run again</button> : null}
          </div>
        </>
      ) : null}
      {confirmCancel ? (
        <ConfirmDialog
          title="Cancel this search?"
          message="Queued pipeline work will stop. A stage already running may finish its current step."
          confirmLabel="Cancel search"
          busy={busy}
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => void cancel()}
        />
      ) : null}
    </section>
  );
}

function heading(pipeline: PipelineView | null) {
  if (!pipeline) return 'Search progress';
  if (pipeline.status === 'COMPLETED') return 'Search completed';
  if (pipeline.status === 'PARTIAL') return 'Search completed with some issues';
  if (pipeline.status === 'FAILED') return 'Search could not be completed';
  if (pipeline.status === 'CANCELLED') return 'Search cancelled';
  return 'Search in progress';
}
