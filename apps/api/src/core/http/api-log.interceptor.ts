import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { RequestContextStore } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { newId } from '../ids/id.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Writes the API request log that backs the developer portal's request
 * inspector. Failures here never surface to the caller — an observability
 * write must not break a working request.
 */
@Injectable()
export class ApiLogInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<{ method: string; url: string; routeOptions?: { url?: string } }>();
    const started = Date.now();

    const write = (statusCode: number, errorCode?: string) => {
      const ctx = RequestContextStore.get();
      void this.prisma.raw.apiRequestLog
        .create({
          data: {
            id: newId('requestLog'),
            organizationId: ctx?.organizationId ?? null,
            method: request.method,
            path: request.routeOptions?.url ?? request.url.split('?')[0],
            statusCode,
            durationMs: Date.now() - started,
            principalType: ctx?.principal?.type ?? null,
            principalId: ctx?.principal?.id ?? null,
            ipAddress: ctx?.ipAddress ?? null,
            userAgent: ctx?.userAgent ?? null,
            requestId: ctx?.requestId ?? 'unknown',
            errorCode: errorCode ?? null,
          },
        })
        .catch(() => undefined);
    };

    return next.handle().pipe(
      tap(() => write(http.getResponse<{ statusCode: number }>().statusCode)),
      catchError((error) => {
        write(error instanceof AppError ? error.status : (error?.status ?? 500),
          error instanceof AppError ? error.code : 'internal_error');
        throw error;
      }),
    );
  }
}
