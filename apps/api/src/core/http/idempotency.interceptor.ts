import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RequestContextStore } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { newId } from '../ids/id.service';
import { PrismaService } from '../prisma/prisma.service';
import { raw } from './response.interceptor';

const TTL_HOURS = 24;

/**
 * Honours `Idempotency-Key` on creating requests. A repeat of the same key with
 * the same body replays the stored response; the same key with a different body
 * is a client bug and is rejected rather than silently doing something new.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | undefined>;
      body?: unknown;
      routeOptions?: { url?: string };
      url: string;
    }>();

    const key = request.headers['idempotency-key'];
    if (!key || request.method !== 'POST') return next.handle();

    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return next.handle();

    const endpoint = request.routeOptions?.url ?? request.url;
    const requestHash = createHash('sha256').update(JSON.stringify(request.body ?? {})).digest('hex');

    const existing = await this.prisma.raw.idempotencyKey.findUnique({
      where: { organizationId_key_endpoint: { organizationId, key, endpoint } },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw AppError.conflict('This idempotency key was already used with a different request body');
      }
      if (existing.response) {
        return of(raw(existing.response as Record<string, unknown>));
      }
      // A concurrent request holds the key and has not finished yet.
      throw AppError.conflict('A request with this idempotency key is still in flight');
    }

    await this.prisma.raw.idempotencyKey.create({
      data: {
        id: newId('idempotency'),
        organizationId,
        key,
        endpoint,
        requestHash,
        expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000),
      },
    });

    return next.handle().pipe(
      tap({
        next: async (payload) => {
          await this.prisma.raw.idempotencyKey
            .update({
              where: { organizationId_key_endpoint: { organizationId, key, endpoint } },
              data: { statusCode: 201, response: { data: payload } as never },
            })
            .catch(() => undefined);
        },
        error: async () => {
          // Release the key so the client can legitimately retry a failed call.
          await this.prisma.raw.idempotencyKey
            .delete({ where: { organizationId_key_endpoint: { organizationId, key, endpoint } } })
            .catch(() => undefined);
        },
      }),
    );
  }
}
