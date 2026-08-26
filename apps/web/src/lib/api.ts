'use client';

/**
 * The API client.
 *
 * One place holds the access token, refreshes it when it expires, and retries
 * the request that discovered the expiry — so no screen has to think about
 * token lifetime.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE = `${API_URL}/api/v1`;

const ACCESS_KEY = 'atrrehub.accessToken';
const REFRESH_KEY = 'atrrehub.refreshToken';

export interface ApiProblem {
  status: number;
  code: string;
  detail: string;
  errors?: { path: string; message: string }[];
  requestId?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.detail);
    this.name = 'ApiError';
  }
}

export const tokens = {
  access: (): string | null => (typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY)),
  refresh: (): string | null => (typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY)),
  set(accessToken: string, refreshToken: string): void {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/** Concurrent 401s share one refresh instead of racing to rotate the token. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = tokens.refresh();
  if (!refreshToken) return false;

  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        tokens.clear();
        return false;
      }
      const { data } = await response.json();
      tokens.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Set false for auth endpoints that must not trigger a refresh loop. */
  retryOnUnauthorized?: boolean;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const send = async (): Promise<Response> => {
    const accessToken = tokens.access();
    return fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  };

  let response = await send();

  if (response.status === 401 && options.retryOnUnauthorized !== false && (await refreshSession())) {
    response = await send();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload.code ?? 'internal_error',
      detail: payload.detail ?? response.statusText,
      errors: payload.errors,
      requestId: payload.requestId,
    });
  }

  // Collections keep their envelope; single resources are unwrapped.
  return (payload.meta ? payload : (payload.data ?? payload)) as T;
}

export const get = <T>(path: string, query?: RequestOptions['query']) => api<T>(path, { query });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
