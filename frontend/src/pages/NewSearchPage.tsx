import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { pipelineApi, searchApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { SearchForm } from '../components/search/SearchForm';
import { useToasts } from '../feedback/toasts';
import type { SearchPreview } from '../types/api';

export function NewSearchPage() {
  const navigate = useNavigate();
  const { notify } = useToasts();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SearchPreview | null>(null);

  return (
    <section className="stack">
      <SearchForm
        busy={busy}
        onPreview={async (prompt) => {
          setBusy(true);
          try {
            setPreview(await searchApi.preview(prompt));
          } catch (error) {
            notify('error', error instanceof ApiError ? error.message : 'Unable to preview this search.');
          } finally {
            setBusy(false);
          }
        }}
        onSubmit={async (draft) => {
          setBusy(true);
          try {
            const search = await searchApi.create(draft.name, draft.prompt);
            await pipelineApi.start(search.id);
            notify('success', 'Search started');
            navigate(`/search-history/${search.id}`);
          } catch (error) {
            notify('error', error instanceof ApiError ? error.message : 'Unable to start the search.');
          } finally {
            setBusy(false);
          }
        }}
      />
      {preview ? (
        <section className="panel">
          <h2>Interpreted criteria</h2>
          <p>Lead types: {preview.structuredPlan.leadTypes?.join(', ') || 'Not Found'}</p>
          <p>Industry: {preview.structuredPlan.industry?.join(', ') || 'Not Found'}</p>
          <p>Locations: {preview.structuredPlan.locations?.map((item) => [item.city, item.state, item.country].filter(Boolean).join(', ')).join(' · ') || 'Not Found'}</p>
        </section>
      ) : null}
    </section>
  );
}
