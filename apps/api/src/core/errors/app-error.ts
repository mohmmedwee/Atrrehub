/**
 * Domain errors carry a stable machine-readable code so clients can branch on
 * behaviour rather than parsing prose. Serialized as RFC 9457 problem details
 * by the exception filter.
 */
export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'policy_blocked'
  | 'quota_exceeded'
  | 'internal_error'
  | 'dependency_unavailable'
  | 'not_implemented';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  permission_denied: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  policy_blocked: 451,
  quota_exceeded: 429,
  internal_error: 500,
  dependency_unavailable: 503,
  not_implemented: 501,
};

export interface FieldError {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly errors?: FieldError[];
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { errors?: FieldError[]; meta?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.errors = options?.errors;
    this.meta = options?.meta;
    Error.captureStackTrace?.(this, AppError);
  }

  /**
   * A resource that exists in another tenant is reported as missing — existence
   * must not leak across the tenant boundary.
   */
  static notFound(resource: string, id?: string): AppError {
    return new AppError(
      'not_found',
      id ? `${resource} ${id} was not found` : `${resource} was not found`,
    );
  }

  static badRequest(message: string, errors?: FieldError[]): AppError {
    return new AppError('bad_request', message, { errors });
  }

  static validation(message: string, errors: FieldError[]): AppError {
    return new AppError('validation_failed', message, { errors });
  }

  static unauthenticated(message = 'Authentication is required'): AppError {
    return new AppError('unauthenticated', message);
  }

  static permissionDenied(permission: string): AppError {
    return new AppError('permission_denied', `Missing required permission: ${permission}`, {
      meta: { permission },
    });
  }

  static conflict(message: string, meta?: Record<string, unknown>): AppError {
    return new AppError('conflict', message, { meta });
  }

  static versionConflict(resource: string, expected: number, actual: number): AppError {
    return new AppError('version_conflict', `${resource} was modified by another request`, {
      meta: { expected, actual },
    });
  }

  static quotaExceeded(metric: string, limit: number): AppError {
    return new AppError('quota_exceeded', `Quota exceeded for ${metric} (limit ${limit})`, {
      meta: { metric, limit },
    });
  }

  static policyBlocked(policy: string, detail: string): AppError {
    return new AppError('policy_blocked', detail, { meta: { policy } });
  }

  static dependency(name: string, cause?: unknown): AppError {
    return new AppError('dependency_unavailable', `${name} is unavailable`, { cause });
  }

  static internal(message = 'An unexpected error occurred', cause?: unknown): AppError {
    return new AppError('internal_error', message, { cause });
  }
}
