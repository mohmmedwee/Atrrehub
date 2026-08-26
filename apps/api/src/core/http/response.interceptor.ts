import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const RAW_RESPONSE = Symbol('raw-response');

/** Marks a payload as already shaped, so the envelope interceptor leaves it alone. */
export function raw<T extends object>(payload: T): T {
  return Object.assign(payload, { [RAW_RESPONSE]: true });
}

export interface Paginated<T> {
  data: T[];
  meta: { total?: number; limit: number; cursor?: string | null };
  links?: { next?: string | null };
}

export function isPaginated(value: unknown): value is Paginated<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Paginated<unknown>).data) &&
    typeof (value as Paginated<unknown>).meta === 'object'
  );
}

/**
 * Wraps handler results in the `{ data }` envelope described in the API
 * standards. Handlers that already return a paginated or pre-shaped body pass
 * through untouched.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    return next.handle().pipe(
      map((payload) => {
        if (payload === undefined || payload === null) return { data: null };
        if (typeof payload === 'object' && RAW_RESPONSE in (payload as object)) {
          const { [RAW_RESPONSE]: _flag, ...rest } = payload as Record<string | symbol, unknown>;
          return rest;
        }
        if (isPaginated(payload)) return payload;
        return { data: payload };
      }),
    );
  }
}
