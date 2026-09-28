import { ListLeadsDto } from '../leads/dto/list-leads.dto';
import type { ExportMode, MissingValueMode } from './types/export.types';

export function applyExportMode(filters: ListLeadsDto, mode: ExportMode): ListLeadsDto {
  const next = Object.assign(new ListLeadsDto(), filters);
  if (mode === 'QUALIFIED') next.qualificationStatus = 'QUALIFIED';
  if (mode === 'VERIFIED_CONTACTS') next.hasVerifiedContact = true;
  return next;
}

export function parseStoredExportFilters(value: unknown): {
  filters: ListLeadsDto;
  exportMode: ExportMode;
  missingValueMode: MissingValueMode;
} {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const exportMode: ExportMode = raw.exportMode === 'QUALIFIED' || raw.exportMode === 'VERIFIED_CONTACTS' || raw.exportMode === 'ALL'
    ? raw.exportMode
    : 'ALL';
  const missingValueMode: MissingValueMode = raw.missingValueMode === 'EMPTY' ? 'EMPTY' : 'NOT_FOUND';
  const rest = { ...raw };
  delete rest.exportMode;
  delete rest.missingValueMode;
  return {
    filters: Object.assign(new ListLeadsDto(), rest),
    exportMode,
    missingValueMode,
  };
}

export function buildExportAuditMetadata(input: {
  userId: string | null;
  organizationId: string;
  searchExecutionId?: string | null;
  exportFormat: string;
  exportMode?: ExportMode;
  leadCount?: number | null;
  extra?: Record<string, unknown>;
}) {
  return {
    userId: input.userId,
    organizationId: input.organizationId,
    searchExecutionId: input.searchExecutionId ?? null,
    exportFormat: input.exportFormat,
    ...(input.exportMode ? { exportMode: input.exportMode } : {}),
    ...(input.leadCount != null ? { leadCount: input.leadCount } : {}),
    timestamp: new Date().toISOString(),
    ...input.extra,
  };
}
