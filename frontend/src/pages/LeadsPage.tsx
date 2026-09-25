import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createExport, exportApi, getLeads, pageItems, searchApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { ErrorState } from '../components/feedback/States';
import { TableSkeleton } from '../components/feedback/Skeletons';
import { ExportButton } from '../components/leads/ExportButton';
import { LeadFilters, type LeadFilterValues } from '../components/leads/LeadFilters';
import { LeadTable } from '../components/leads/LeadTable';
import { useToasts } from '../feedback/toasts';
import type { ExportRecord, LeadFilters as LeadQuery, LeadRecord, LeadSortBy, SearchExecutionSummary } from '../types/api';

const sortFields: LeadSortBy[] = ['score', 'companyName', 'createdAt', 'updatedAt', 'lastVerifiedAt'];

function readSort(value: string | null): LeadSortBy {
  return sortFields.includes(value as LeadSortBy) ? value as LeadSortBy : 'createdAt';
}

function readOrder(value: string | null): 'asc' | 'desc' {
  return value === 'asc' ? 'asc' : 'desc';
}

function flag(value: string | null): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readSizeStatus(value: string | null): LeadQuery['companySizeStatus'] {
  if (value === 'MATCHED' || value === 'UNKNOWN' || value === 'OUTSIDE_RANGE') return value;
  return undefined;
}

function numberValue(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function valuesFrom(params: URLSearchParams, search: string): LeadFilterValues {
  return {
    search,
    state: params.get('state') ?? '',
    city: params.get('city') ?? '',
    country: params.get('country') ?? '',
    zipCode: params.get('zipCode') ?? '',
    investorType: params.get('investorType') ?? '',
    qualificationStatus: params.get('qualificationStatus') ?? '',
    verificationStatus: params.get('verificationStatus') ?? '',
    classification: params.get('classification') ?? '',
    minScore: params.get('minScore') ?? '',
    maxScore: params.get('maxScore') ?? '',
    scoreBand: params.get('scoreBand') ?? '',
    searchExecutionId: params.get('searchExecutionId') ?? '',
    hasDecisionMaker: params.get('hasDecisionMaker') ?? '',
    hasEmail: params.get('hasEmail') ?? '',
    hasPhone: params.get('hasPhone') ?? '',
    companySizeStatus: params.get('companySizeStatus') ?? '',
  };
}

function queryFrom(params: URLSearchParams): LeadQuery {
  return {
    page: Number(params.get('page') ?? '1') || 1,
    limit: 25,
    sortBy: readSort(params.get('sortBy')),
    sortOrder: readOrder(params.get('sortOrder')),
    search: params.get('search') || undefined,
    state: params.get('state') || undefined,
    city: params.get('city') || undefined,
    country: params.get('country') || undefined,
    zipCode: params.get('zipCode') || undefined,
    investorType: params.get('investorType') || undefined,
    qualificationStatus: params.get('qualificationStatus') || undefined,
    verificationStatus: params.get('verificationStatus') || undefined,
    classification: params.get('classification') || undefined,
    minScore: numberValue(params.get('minScore')),
    maxScore: numberValue(params.get('maxScore')),
    scoreBand: params.get('scoreBand') || undefined,
    searchExecutionId: params.get('searchExecutionId') || undefined,
    hasDecisionMaker: flag(params.get('hasDecisionMaker')),
    hasEmail: flag(params.get('hasEmail')),
    hasPhone: flag(params.get('hasPhone')),
    companySizeStatus: readSizeStatus(params.get('companySizeStatus')),
    companySizeMin: params.get('companySizeStatus') === 'MATCHED' || params.get('companySizeStatus') === 'OUTSIDE_RANGE' ? 1 : undefined,
    companySizeMax: params.get('companySizeStatus') === 'MATCHED' || params.get('companySizeStatus') === 'OUTSIDE_RANGE' ? 50 : undefined,
  };
}

export function LeadsPage() {
  const { notify } = useToasts();
  const [params, setParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(params.get('search') ?? '');
  const [rows, setRows] = useState<LeadRecord[] | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [executions, setExecutions] = useState<SearchExecutionSummary[]>([]);
  const [exportPhase, setExportPhase] = useState<'idle' | 'creating' | 'ready' | 'failed'>('idle');
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportRecord, setExportRecord] = useState<ExportRecord | null>(null);
  const page = Number(params.get('page') ?? '1') || 1;
  const sortBy = readSort(params.get('sortBy'));
  const sortOrder = readOrder(params.get('sortOrder'));
  const searchParam = params.get('search') ?? '';
  const writtenSearch = useRef(searchParam);

  useEffect(() => {
    if (searchParam !== writtenSearch.current) {
      writtenSearch.current = searchParam;
      setSearchInput(searchParam);
    }
  }, [searchParam]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      const trimmed = searchInput.trim();
      writtenSearch.current = trimmed;
      if (trimmed) next.set('search', trimmed);
      else next.delete('search');
      if (next.get('search') !== params.get('search')) {
        next.set('page', '1');
        setParams(next);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, params, setParams]);

  useEffect(() => {
    setSelected(new Set());
  }, [params]);

  useEffect(() => {
    searchApi.executions().then((result) => setExecutions(pageItems(result))).catch(() => setExecutions([]));
  }, []);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);
    getLeads(queryFrom(params)).then((result) => {
      if (!active) return;
      setRows(pageItems(result));
      setTotalPages(result.pagination?.totalPages ?? 1);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof ApiError ? reason.message : 'Unable to load leads. Please try again.');
    });
    return () => { active = false; };
  }, [params]);

  useEffect(() => {
    if (exportPhase !== 'creating' || !exportRecord) return undefined;
    let active = true;
    const timer = window.setInterval(() => {
      exportApi.get(exportRecord.id).then((record) => {
        if (!active) return;
        if (record.status === 'COMPLETED') {
          setExportRecord(record);
          setExportPhase('ready');
        } else if (record.status === 'FAILED' || record.status === 'CANCELLED' || record.status === 'EXPIRED') {
          setExportPhase('failed');
          setExportMessage('The export failed.');
        }
      }).catch((reason: unknown) => {
        if (!active) return;
        setExportPhase('failed');
        setExportMessage(reason instanceof ApiError ? reason.message : 'Unable to check the export.');
      });
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [exportPhase, exportRecord]);

  function update(key: keyof LeadFilterValues, value: string) {
    if (key === 'search') return;
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set('page', '1');
    setParams(next);
  }

  function setPage(nextPage: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(nextPage));
    setParams(next);
  }

  function toggleSort(column: LeadSortBy) {
    const next = new URLSearchParams(params);
    if (sortBy === column) next.set('sortOrder', sortOrder === 'asc' ? 'desc' : 'asc');
    else {
      next.set('sortBy', column);
      next.set('sortOrder', 'asc');
    }
    next.set('page', '1');
    setParams(next);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create(format: 'csv' | 'xlsx') {
    setExportPhase('creating');
    setExportMessage(null);
    setExportRecord(null);
    try {
      const created = await createExport(format, queryFrom(params));
      const record = await exportApi.get(created.exportId);
      setExportRecord(record);
      if (record.status === 'COMPLETED') setExportPhase('ready');
      else if (record.status === 'FAILED' || record.status === 'CANCELLED' || record.status === 'EXPIRED') {
        setExportPhase('failed');
        setExportMessage('The export failed.');
      }
    } catch (reason) {
      setExportPhase('failed');
      setExportMessage(reason instanceof ApiError ? reason.message : 'Unable to create the export.');
      notify('error', reason instanceof ApiError ? reason.message : 'Unable to create the export.');
    }
  }

  async function download() {
    if (!exportRecord) return;
    try {
      const blob = await exportApi.download(exportRecord.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exportRecord.fileName || `export.${exportRecord.format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      notify('error', reason instanceof ApiError ? reason.message : 'Unable to download the export.');
    }
  }

  return (
    <section className="stack">
      <LeadFilters values={valuesFrom(params, searchInput)} executions={executions} onSearchChange={setSearchInput} onChange={update} />
      <ExportButton phase={exportPhase} message={exportMessage} onCreate={(format) => void create(format)} onDownload={() => void download()} />
      {selected.size ? <p className="muted">Selected on this page: {selected.size}</p> : null}
      {error ? <ErrorState message={error} /> : null}
      {rows === null && !error ? <TableSkeleton /> : null}
      {rows ? (
        <LeadTable
          leads={rows}
          selected={selected}
          onToggle={toggle}
          onTogglePage={(ids, checked) => setSelected(checked ? new Set(ids) : new Set())}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={toggleSort}
        />
      ) : null}
      <div className="actions">
        <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  );
}
