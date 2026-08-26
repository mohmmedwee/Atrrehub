import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import { RequestContextStore } from '../context/request-context';

/**
 * Opens the AsyncLocalStorage scope for the request. Everything downstream —
 * logging correlation, tenant scoping, audit attribution — reads from here.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: FastifyRequest['raw'] & { headers: Record<string, any> }, reply: FastifyReply['raw'], next: () => void) {
    const headerId = request.headers['x-request-id'];
    const requestId = (Array.isArray(headerId) ? headerId[0] : headerId) ?? `req_${ulid()}`;
    const forwarded = request.headers['x-forwarded-for'];
    const ipAddress = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();

    reply.setHeader('x-request-id', requestId);

    RequestContextStore.run(
      {
        requestId,
        ipAddress: ipAddress ?? (request as any).socket?.remoteAddress,
        userAgent: request.headers['user-agent'] as string | undefined,
        startedAt: Date.now(),
      },
      next,
    );
  }
}
