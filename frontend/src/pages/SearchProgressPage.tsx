import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { pipelineApi, searchApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { ErrorState, Skeleton } from '../components/feedback/States';
import { PipelineProgress } from '../components/search/PipelineProgress';
import { useToasts } from '../feedback/toasts';
import type { PipelineView, SearchRecord } from '../types/api';

export function SearchProgressPage() {
  const { searchId = '' } = useParams();
  const { notify } = useToasts();
  const [search, setSearch] = useState<SearchRecord | null>(null);
  const [pipeline, setPipeline] = useState<PipelineView | null>(null);
  const [missingPipeline, setMissingPipeline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    searchApi.get(searchId).then((record) => {
      if (active) setSearch(record);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof ApiError ? reason.message : 'Unable to load this search.');
    });
    return () => { active = false; };
  }, [searchId]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const load = () => {
      pipelineApi.get(searchId).then((view) => {
        if (!active) return;
        setPipeline(view);
        setMissingPipeline(false);
        if (view.status === 'QUEUED' || view.status === 'RUNNING') timer = window.setTimeout(load, 4000);
      }).catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 404) setMissingPipeline(true);
        else setError(reason instanceof ApiError ? reason.message : 'Unable to load search progress.');
      });
    };
    load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchId]);

  async function start() {
    setBusy(true);
    try {
      const view = await pipelineApi.start(searchId);
      setPipeline(view);
      setMissingPipeline(false);
      notify('success', 'Search started');
    } catch (reason) {
      notify('error', reason instanceof ApiError ? reason.message : 'Unable to start the search.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  return (
    <section className="stack">
      <p><Link to="/search-history">Back to search history</Link></p>
      <h2>{search?.name ?? 'Search'}</h2>
      <p>{search?.originalPrompt || 'Not Found'}</p>
      {!pipeline && !missingPipeline ? <Skeleton rows={4} /> : null}
      {missingPipeline ? <button type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Starting search' : 'Start search'}</button> : null}
      {pipeline ? <PipelineProgress pipeline={pipeline} /> : null}
    </section>
  );
}
