/**
 * The error the API actually returns: an RFC 9457 problem document.
 *
 * Branch on `code`, not on `status` and not on the prose in `detail`. The code
 * is the part of the contract that will not change; `detail` is written for a
 * human reading a log.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance?: string;
  requestId: string;
  errors?: { field: string; message: string }[];
  meta?: Record<string, unknown>;
}

export class AtrrehubError extends Error {
  readonly status: number;
  readonly code: string;
  /** Quote this in a support request — it locates the exact request in our logs. */
  readonly requestId: string;
  readonly fieldErrors: { field: string; message: string }[];
  readonly problem?: ProblemDetails;

  constructor(problem: ProblemDetails | { status: number; detail: string }, cause?: unknown) {
    super(problem.detail);
    this.name = 'AtrrehubError';
    this.status = problem.status;
    this.code = 'code' in problem ? problem.code : 'transport_error';
    this.requestId = 'requestId' in problem ? problem.requestId : '';
    this.fieldErrors = ('errors' in problem ? problem.errors : undefined) ?? [];
    this.problem = 'code' in problem ? problem : undefined;
    if (cause !== undefined) this.cause = cause;
  }

  /** Whether trying the same request again could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
