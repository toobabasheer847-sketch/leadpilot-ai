import { useState } from 'react';
import { Field } from '../feedback/States';

export interface SearchDraft {
  name: string;
  prompt: string;
}

export function validateSearch(draft: SearchDraft): Partial<Record<keyof SearchDraft, string>> {
  const errors: Partial<Record<keyof SearchDraft, string>> = {};
  if (!draft.name.trim()) errors.name = 'Enter a search name.';
  else if (draft.name.trim().length > 255) errors.name = 'Search name must be 255 characters or fewer.';
  if (!draft.prompt.trim()) errors.prompt = 'Enter a search prompt.';
  else if (draft.prompt.trim().length > 5000) errors.prompt = 'Search prompt must be 5000 characters or fewer.';
  return errors;
}

export function SearchForm({ busy, onSubmit, onPreview }: {
  busy: boolean;
  onSubmit: (draft: SearchDraft) => Promise<void> | void;
  onPreview: (prompt: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<SearchDraft>({ name: '', prompt: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof SearchDraft, string>>>({});

  return (
    <form className="panel form-grid" onSubmit={(event) => {
      event.preventDefault();
      const next = validateSearch(draft);
      setErrors(next);
      if (Object.keys(next).length === 0) void onSubmit({ name: draft.name.trim(), prompt: draft.prompt.trim() });
    }}>
      <Field label="Search name" hint={errors.name}>
        <input name="name" value={draft.name} maxLength={255} aria-invalid={Boolean(errors.name)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </Field>
      <Field label="Search prompt" hint={errors.prompt ?? 'The backend interprets location, category, and other criteria from this prompt.'}>
        <textarea name="prompt" rows={5} value={draft.prompt} maxLength={5000} aria-invalid={Boolean(errors.prompt)} placeholder="Find real estate investors in Texas" onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
      </Field>
      <div className="actions">
        <button type="submit" disabled={busy}>{busy ? 'Starting search' : 'Start search'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          const next = validateSearch({ name: draft.name || 'Preview', prompt: draft.prompt });
          if (next.prompt) setErrors(next);
          else void onPreview(draft.prompt.trim());
        }}>Preview criteria</button>
      </div>
    </form>
  );
}
