import { AtrrehubError, type ProblemDetails } from './errors.js';

export interface ClientOptions {
  /** e.g. `https://api.atrrehub.com`. The `/api/v1` prefix is added for you. */
  baseUrl: string;
  /** An API key (`ak_…`). Mutually exclusive with `accessToken`. */
  apiKey?: string;
  /** A user access token, for acting as a signed-in person. */
  accessToken?: string;
  /** Per-request ceiling, in milliseconds. Default 30 seconds. */
  timeoutMs?: number;
  /** How many times to retry a retryable failure. Default 2. */
  maxRetries?: number;
  /** Swap in a different fetch — a test double, or one with a proxy agent. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * Makes a write safe to retry: the server replays the first response rather
   * than performing the operation twice. Generated automatically for POST,
   * PATCH and PUT unless you supply your own.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** The `{ data }` envelope every non-paginated endpoint returns. */
interface Envelope<T> {
  data: T;
}

export interface Page<T> {
  data: T[];
  meta: { total?: number; limit: number; cursor?: string | null };
  links?: { next?: string | null };
}

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * The transport every generated method goes through.
 *
 * Hand-written, and deliberately the only hand-written part of the client: the
 * operations are generated from the API's own OpenAPI document, but retries,
 * idempotency and error mapping are decisions rather than descriptions, and
 * generating them would mean regenerating every judgement each time an endpoint
 * is added.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    if (!options.apiKey && !options.accessToken) {
      throw new Error('Provide either an apiKey or an accessToken');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const body = await this.send(method, path, options);
    // A 204 has no body, and the endpoints that return one return nothing.
    if (body === undefined) return undefined as T;
    if (isPage(body)) return body as T;
    return (body as Envelope<T>).data;
  }

  /** For endpoints that page: returns the envelope rather than unwrapping it. */
  async paginate<T>(method: string, path: string, options: RequestOptions = {}): Promise<Page<T>> {
    return (await this.send(method, path, options)) as Page<T>;
  }

  private async send(method: string, path: string, options: RequestOptions): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.options.headers,
      ...options.headers,
    };
    if (this.options.apiKey) headers['x-api-key'] = this.options.apiKey;
    if (this.options.accessToken) headers.authorization = `Bearer ${this.options.accessToken}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const mutating = !RETRYABLE_METHODS.has(method);
    if (mutating) {
      // Without this a timeout on a create leaves the caller unable to retry
      // safely, which is the moment they most want to.
      headers['idempotency-key'] = options.idempotencyKey ?? crypto.randomUUID();
    }

    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: AtrrehubError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs(attempt));
      try {
        return await this.once(method, url, headers, options);
      } catch (error) {
        if (!(error instanceof AtrrehubError) || !error.isRetryable) throw error;
        // A mutating request is only safe to repeat because of the idempotency
        // key above; without one the server would perform it twice.
        if (mutating && !headers['idempotency-key']) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private async once(
    method: string,
    url: URL,
    headers: Record<string, string>,
    options: RequestOptions,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      // A transport failure has no problem document, but callers still need a
      // single error type to catch, and it is retryable like a 503.
      throw new AtrrehubError(
        { status: 503, detail: error instanceof Error ? error.message : String(error) },
        error,
      );
    }

    if (response.status === 204) return undefined;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new AtrrehubError({
        status: response.status,
        detail: `Expected JSON from ${url.pathname} but received ${text.slice(0, 200)}`,
      });
    }

    if (!response.ok) {
      const problem = parsed as Partial<ProblemDetails> | undefined;
      throw new AtrrehubError(
        problem?.code
          ? (problem as ProblemDetails)
          : { status: response.status, detail: `Request failed with ${response.status}` },
      );
    }
    return parsed;
  }
}

function isPage(value: unknown): value is Page<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Page<unknown>).data) &&
    typeof (value as Page<unknown>).meta === 'object'
  );
}

/** Jittered, so a fleet retrying the same outage does not do it in lockstep. */
function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 250, 4_000) * (0.5 + Math.random() / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
