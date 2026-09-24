import { useEffect, useState } from 'react';
import { exportApi, pageItems } from '../api/endpoints';
import { ApiError } from '../api/client';
import { EmptyState, ErrorState, Skeleton, StatusBadge } from '../components/feedback/States';
import { useToasts } from '../feedback/toasts';
import { formatWhen } from '../lib/format';
import type { ExportRecord } from '../types/api';

export function ExportsPage() {
  const { notify } = useToasts();
  const [rows, setRows] = useState<ExportRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);

  function load() {
    setError(null);
    exportApi.list(1).then((result) => setRows(pageItems(result))).catch((reason: unknown) => {
      setError(reason instanceof ApiError ? reason.message : 'Unable to load exports. Please try again.');
    });
  }

  useEffect(() => { load(); }, []);

  async function create(format: 'csv' | 'xlsx') {
    setBusy(format);
    try {
      await exportApi.create(format);
      notify('success', 'Export created');
      load();
    } catch (reason) {
      notify('error', reason instanceof ApiError ? reason.message : 'Unable to create the export.');
    } finally {
      setBusy(null);
    }
  }

  async function download(row: ExportRecord) {
    try {
      const blob = await exportApi.download(row.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = row.fileName || `export.${row.format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      notify('error', reason instanceof ApiError ? reason.message : 'Unable to download the export.');
    }
  }

  return (
    <section className="stack">
      <div className="actions">
        <button type="button" disabled={busy !== null} onClick={() => void create('csv')}>{busy === 'csv' ? 'Creating export' : 'Create CSV'}</button>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void create('xlsx')}>{busy === 'xlsx' ? 'Creating export' : 'Create XLSX'}</button>
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      {rows === null && !error ? <Skeleton rows={3} /> : null}
      {rows && rows.length === 0 ? <EmptyState title="No exports available" detail="Create a CSV or XLSX export from the current lead set." /> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>File</th><th>Format</th><th>Status</th><th>Rows</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.fileName || 'Not available'}</td>
                  <td>{row.format}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>{row.rowCount ?? 'Not available'}</td>
                  <td>{formatWhen(row.createdAt)}</td>
                  <td>{row.status === 'COMPLETED' ? <button type="button" onClick={() => void download(row)}>Download</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
