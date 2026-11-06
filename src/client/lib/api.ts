import type { ApiError as ApiErrorBody, Page } from '@shared/api';

/** Error thrown by every API call. `status` is 0 for network failures. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {
  if (!location.pathname.startsWith('/login')) location.assign('/login');
};

/** App installs a router-aware handler so a 401 navigates without a reload. */
export function setUnauthorizedHandler(fn: UnauthorizedHandler): void {
  onUnauthorized = fn;
}

/** Auth and setup endpoints answer 401 as part of their normal flow; never redirect for them. */
function redirectsOn401(path: string): boolean {
  return !path.startsWith('/api/auth/') && !path.startsWith('/api/setup');
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

function isErrorBody(x: unknown): x is ApiErrorBody {
  if (typeof x !== 'object' || x === null || !('error' in x)) return false;
  const err = (x as { error: unknown }).error;
  return typeof err === 'object' && err !== null && 'code' in err;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Cirrus'] = '1';
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection.', 0);
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const err = isErrorBody(data)
      ? new ApiError(data.error.code, data.error.message || res.statusText, res.status, data.error.details)
      : new ApiError(`HTTP_${res.status}`, res.statusText || 'Request failed', res.status);
    if (res.status === 401 && redirectsOn401(path)) onUnauthorized();
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * The contract says "lists use cursor pagination" but some list routes may return a bare array.
 * Accept both so the client is robust to either shape.
 */
export function asList<T>(x: T[] | Page<T> | { items: T[] } | null | undefined): T[] {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return Array.isArray(x.items) ? x.items : [];
}

export function asPage<T>(x: T[] | Page<T>): Page<T> {
  if (Array.isArray(x)) return { items: x, nextCursor: null };
  return { items: x.items ?? [], nextCursor: x.nextCursor ?? null };
}

/** Multipart upload through XHR so we get upload progress events. */
export function uploadFile<T>(
  path: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('X-Cirrus', '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.withCredentials = false; // same-origin: cookies are sent anyway
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = undefined;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      if (xhr.status === 401) onUnauthorized();
      reject(
        isErrorBody(data)
          ? new ApiError(data.error.code, data.error.message, xhr.status, data.error.details)
          : new ApiError(`HTTP_${xhr.status}`, 'Upload failed', xhr.status),
      );
    };
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Upload failed. Check your connection.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** Human message for an error, with friendly copy for the sending quota codes. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === 'E_DAILY_LIMIT_EXCEEDED' || (e.status === 429 && e.code.includes('DAILY'))) {
      return "You've reached today's sending quota. Cloudflare starts new accounts with a daily limit that grows as you send real mail, and it resets every day. Your message is safe in Drafts; try again tomorrow.";
    }
    if (e.code === 'E_RATE_LIMIT_EXCEEDED' || e.status === 429) {
      return "You're sending too quickly. Wait a minute and try again. Your message is safe in Drafts.";
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
