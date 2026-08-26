import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { RequestContextStore } from '../context/request-context';
import { AppLogger } from '../logger/logger.service';
import { AppError, type ErrorCode, type FieldError } from './app-error';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance?: string;
  requestId: string;
  errors?: FieldError[];
  meta?: Record<string, unknown>;
}

const DOC_BASE = 'https://docs.atrrehub.com/errors';

const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * RFC 7644 §3.12. `scimType` and the SCIM status are carried on the error's
 * `meta.scim` when the service knows them; otherwise the HTTP status is used,
 * which is what a provider keys its retry behaviour off anyway.
 */
function toScimError(problem: ProblemDetails): Record<string, unknown> {
  const scim = problem.meta?.scim as { scimType?: string; status?: string } | undefined;
  const status = scim?.status ? Number(scim.status) : problem.status;
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    ...(scim?.scimType ? { scimType: scim.scimType } : {}),
    detail: problem.detail,
    status: String(status),
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<{ url?: string; method?: string }>();
    const problem = this.toProblem(exception, request?.url);

    if (problem.status >= 500) {
      this.logger.error('Unhandled request failure', exception, {
        path: request?.url,
        method: request?.method,
        code: problem.code,
      });
    } else if (problem.status >= 400) {
      this.logger.debug('Request rejected', {
        path: request?.url,
        method: request?.method,
        code: problem.code,
        detail: problem.detail,
      });
    }

    // SCIM has its own error body, and identity providers parse it: one that
    // receives an RFC 9457 problem document where it expected a SCIM error
    // reports an opaque failure and, in several implementations, stops
    // synchronizing. This lives here rather than in a controller-scoped filter
    // because a global catch-all filter takes precedence over one, so a
    // scoped filter would never run.
    if (request?.url?.startsWith('/scim/')) {
      const scim = toScimError(problem);
      // The HTTP status and the body's status must agree: a provider keys its
      // retry and alerting off the former and logs the latter.
      void reply.status(Number(scim.status)).type('application/scim+json').send(scim);
      return;
    }

    void reply.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, instance?: string): ProblemDetails {
    const requestId = RequestContextStore.requestId();
    const base = { instance, requestId };

    if (exception instanceof AppError) {
      return {
        ...base,
        type: `${DOC_BASE}/${exception.code}`,
        title: titleFor(exception.code),
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        errors: exception.errors,
        meta: exception.meta,
      };
    }

    if (exception instanceof ZodError) {
      return {
        ...base,
        type: `${DOC_BASE}/validation_failed`,
        title: 'Validation failed',
        status: 422,
        code: 'validation_failed',
        detail: 'The request body failed validation',
        errors: exception.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return { ...base, ...mapPrismaError(exception) };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] })?.message ?? exception.message);
      const code = codeForStatus(status);
      return {
        ...base,
        type: `${DOC_BASE}/${code}`,
        title: titleFor(code),
        status,
        code,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
      };
    }

    return {
      ...base,
      type: `${DOC_BASE}/internal_error`,
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal_error',
      detail: 'An unexpected error occurred. Quote the request id when contacting support.',
    };
  }
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError) {
  switch (error.code) {
    case 'P2002': {
      const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return {
        type: `${DOC_BASE}/conflict`,
        title: 'Conflict',
        status: 409,
        code: 'conflict',
        detail: `A record with this ${target} already exists`,
      };
    }
    case 'P2025':
      return {
        type: `${DOC_BASE}/not_found`,
        title: 'Not found',
        status: 404,
        code: 'not_found',
        detail: 'The requested record was not found',
      };
    case 'P2003':
      return {
        type: `${DOC_BASE}/bad_request`,
        title: 'Bad request',
        status: 400,
        code: 'bad_request',
        detail: 'A referenced record does not exist',
      };
    default:
      return {
        type: `${DOC_BASE}/internal_error`,
        title: 'Internal server error',
        status: 500,
        code: 'internal_error',
        detail: 'A database error occurred',
      };
  }
}

function codeForStatus(status: number): ErrorCode {
  const map: Record<number, ErrorCode> = {
    400: 'bad_request',
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    422: 'validation_failed',
    429: 'rate_limited',
    451: 'policy_blocked',
    501: 'not_implemented',
    503: 'dependency_unavailable',
  };
  return map[status] ?? 'internal_error';
}

function titleFor(code: string): string {
  return code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
