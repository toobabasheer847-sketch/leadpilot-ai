import { apiBlob, apiRequest } from './client';
import type { AuthSession, AuthUser, ExportRecord, LeadFilters, LeadRecord, PageResult, PipelineView, ResearchExecution, SearchExecutionSummary, SearchPreview, SearchRecord } from '../types/api';

export const sessionKey = 'leadpilot.accessToken';

export function readToken(): string | null {
  return localStorage.getItem(sessionKey);
}

export function writeToken(token: string | null) {
  if (token) localStorage.setItem(sessionKey, token);
  else localStorage.removeItem(sessionKey);
}

function authed<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}) {
  return apiRequest<T>(path, { ...options, token: readToken() });
}

export const authApi = {
  login: (email: string, password: string) => apiRequest<AuthSession>('/auth/login', { method: 'POST', body: { email, password } }),
  register: (input: { name: string; email: string; password: string; organizationName: string }) => apiRequest<AuthSession>('/auth/register', { method: 'POST', body: input }),
  me: () => authed<AuthUser>('/auth/me'),
};

export const searchApi = {
  preview: (prompt: string) => authed<SearchPreview>('/searches/preview', { method: 'POST', body: { prompt } }),
  create: (name: string, prompt: string) => authed<SearchRecord>('/searches', { method: 'POST', body: { name, prompt } }),
  list: (page = 1) => authed<PageResult<SearchRecord>>('/searches', { query: { page, limit: 20 } }),
  get: (searchId: string) => authed<SearchRecord>(`/searches/${searchId}`),
  executions: (page = 1) => authed<PageResult<SearchExecutionSummary>>('/search-executions', { query: { page, limit: 20 } }),
};

export const pipelineApi = {
  start: (searchId: string) => authed<PipelineView>(`/searches/${searchId}/pipeline`, { method: 'POST' }),
  get: (searchId: string) => authed<PipelineView>(`/searches/${searchId}/pipeline`),
};

export const leadApi = {
  list: (filters: LeadFilters) => authed<PageResult<LeadRecord>>('/leads', { query: { ...filters } as Record<string, string | number | boolean | undefined> }),
};

export const researchApi = {
  list: (companyId: string) => authed<ResearchExecution[]>(`/companies/${companyId}/research`),
  start: (companyId: string) => authed<{ researchExecutionId: string; status: string }>(`/companies/${companyId}/research`, { method: 'POST' }),
};

export const exportApi = {
  list: (page = 1) => authed<PageResult<ExportRecord>>('/exports', { query: { page, limit: 20 } }),
  create: (format: 'csv' | 'xlsx') => authed<{ exportId: string; status: string }>('/exports', { method: 'POST', body: { format } }),
  download: (id: string) => {
    const token = readToken();
    if (!token) throw new Error('Please sign in to continue.');
    return apiBlob(`/exports/${id}/download`, token);
  },
};

export function pageTotal<T>(result: PageResult<T> | null | undefined): number | null {
  if (!result) return null;
  if (typeof result.pagination?.total === 'number') return result.pagination.total;
  if (typeof result.total === 'number') return result.total;
  return null;
}

export function pageItems<T>(result: PageResult<T> | null | undefined): T[] {
  if (!result) return [];
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.items)) return result.items;
  return [];
}
