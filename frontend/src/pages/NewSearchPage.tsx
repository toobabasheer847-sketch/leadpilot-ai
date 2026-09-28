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
            const view = await pipelineApi.execute(search.id);
            notify('success', 'Search started');
            navigate(view.executionId ? `/search/${search.id}/execution/${view.executionId}` : `/search-history/${search.id}`);
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
          <p>Target: {preview.structuredPlan.targetType ?? 'COMPANIES'}</p>
          <p>Requested count: {preview.structuredPlan.requestedCount ?? 'Not specified'}{preview.structuredPlan.countIntent ? ` (${preview.structuredPlan.countIntent})` : ''}</p>
          <p>Lead types: {preview.structuredPlan.leadTypes?.join(', ') || 'Not specified'}</p>
          <p>Industry: {preview.structuredPlan.industry?.join(', ') || 'Not specified'}</p>
          <p>Locations: {preview.structuredPlan.locations?.map((item) => item.originalText ?? [item.city, item.state, item.region, item.country].filter(Boolean).join(', ')).join(' · ') || 'Not specified'}</p>
          <p>Employee size: {preview.structuredPlan.employeeSize?.qualitative ?? (preview.structuredPlan.employeeSize ? `${preview.structuredPlan.employeeSize.exact ?? preview.structuredPlan.employeeSize.min ?? ''}${preview.structuredPlan.employeeSize.exact == null && preview.structuredPlan.employeeSize.max != null ? `–${preview.structuredPlan.employeeSize.max}` : ''}` : 'Not specified')}</p>
          <p>Decision-maker roles: {preview.structuredPlan.decisionMakerRoles?.join(', ') || 'Not specified'}</p>
          <p>Required fields: {preview.structuredPlan.requiredFields?.join(', ') || 'None'}</p>
          <p>Preferred fields: {preview.structuredPlan.preferredFields?.join(', ') || 'None'}</p>
          <p>Social platforms: {preview.structuredPlan.socialPlatforms?.join(', ') || 'None'}</p>
          <p>Email verified: {preview.structuredPlan.emailRequirement?.verified ? 'Yes' : 'No'}</p>
          <p>Planner: {preview.structuredPlan.planning?.method ?? 'Unknown'}{preview.structuredPlan.planning?.model ? ` (${preview.structuredPlan.planning.model})` : ''}</p>
          {preview.structuredPlan.unresolvedRequirements?.length ? <ul>{preview.structuredPlan.unresolvedRequirements.map((item, index) => <li key={`${item.text}-${index}`}>{item.text}: {item.reason}</li>)}</ul> : null}
        </section>
      ) : null}
    </section>
  );
}
