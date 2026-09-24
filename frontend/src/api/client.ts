const SECRET_PATTERN = /postgres|redis:|api[_-]?key|database_url|secret|bearer |econn|at\s+\S+\s+\(/i;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function messageForStatus(status: number): string {
  if (status === 401) return 'Please sign in to continue.';
  if (status === 403) return 'You do not have access to this resource.';
  if (status === 404) return 'The requested record was not found.';
  if (status === 409) return 'This action conflicts with the current state.';
  if (status === 400 || status === 422) return 'Some fields need to be corrected.';
  if (status === 429) return 'Too many requests. Please wait and try again.';
  if (status >= 500 || status === 0) return 'Unable to complete the request. Please try again.';
  return 'The request could not be completed.';
}

export function readErrorMessage(status: number, body: unknown): string {
  const raw = extractMessage(body);
  if (!raw || status >= 500 || SECRET_PATTERN.test(raw) || raw.length > 180) return messageForStatus(status);
  return raw;
}

function extractMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((item): item is string => typeof item === 'string').join(' ');
  if (message && typeof message === 'object') return extractMessage(message);
  return '';
}

export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (!configured) throw new ApiError(0, 'The API address is not configured.');
  return configured.replace(/\/$/, '');
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  token?: string | null;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${apiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, messageForStatus(0));
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, readErrorMessage(response.status, payload));
  return payload as T;
}

export async function apiBlob(path: string, token: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, messageForStatus(0));
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, readErrorMessage(response.status, payload));
  }
  return response.blob();
}
