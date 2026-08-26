import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { AppError } from '../errors/app-error';
import { MetricsService } from '../metrics/metrics.service';

/** Records latency and error counters for every HTTP request. */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<{ method: string; routerPath?: string; routeOptions?: { url?: string }; url: string }>();
    const method = request.method;
    // Prefer the route template so cardinality stays bounded by endpoint count.
    const route = request.routeOptions?.url ?? request.routerPath ?? 'unknown';
    const stop = this.metrics.httpDuration.startTimer({ method, route });

    return next.handle().pipe(
      tap(() => {
        const status = String(http.getResponse<{ statusCode: number }>().statusCode);
        stop({ status });
      }),
      catchError((error) => {
        const status = error instanceof AppError ? error.status : (error?.status ?? 500);
        const code = error instanceof AppError ? error.code : 'internal_error';
        stop({ status: String(status) });
        this.metrics.httpErrors.inc({ method, route, status: String(status), code });
        throw error;
      }),
    );
  }
}
