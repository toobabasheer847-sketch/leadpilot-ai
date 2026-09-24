export function ExportButton({ phase, message, onCreate, onDownload }: {
  phase: 'idle' | 'creating' | 'ready' | 'failed';
  message?: string | null;
  onCreate: (format: 'csv' | 'xlsx') => void;
  onDownload: () => void;
}) {
  return (
    <div className="actions" aria-live="polite">
      <button type="button" disabled={phase === 'creating'} onClick={() => onCreate('csv')}>CSV</button>
      <button type="button" className="secondary" disabled={phase === 'creating'} onClick={() => onCreate('xlsx')}>XLSX</button>
      {phase === 'creating' ? <span>Creating export...</span> : null}
      {phase === 'ready' ? (
        <>
          <span>Export ready</span>
          <button type="button" onClick={onDownload}>Download</button>
        </>
      ) : null}
      {phase === 'failed' && message ? <span role="alert">{message}</span> : null}
    </div>
  );
}
