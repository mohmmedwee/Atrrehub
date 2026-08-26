import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { RequestContextStore } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { RedisService } from '../redis/redis.service';

export interface RateLimitBucket {
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Separate buckets so a burst of AI work cannot starve interactive traffic. */
export const RATE_BUCKETS = {
  auth: { name: 'auth', limit: 10, windowSeconds: 60 },
  api: { name: 'api', limit: 600, windowSeconds: 60 },
  ai: { name: 'ai', limit: 60, windowSeconds: 60 },
  bulk: { name: 'bulk', limit: 10, windowSeconds: 60 },
  widget: { name: 'widget', limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitBucket>;

export const RATE_LIMIT_KEY = 'rate_limit_bucket';
export const RateLimit = (bucket: RateLimitBucket) => SetMetadata(RATE_LIMIT_KEY, bucket);

/**
 * Fixed-window rate limiting, counted per principal and per organization so one
 * noisy integration cannot exhaust a tenant's whole allowance.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const bucket =
      this.reflector.getAllAndOverride<RateLimitBucket>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? RATE_BUCKETS.api;

    const ctx = RequestContextStore.get();
    const identity = ctx?.principal?.id ?? ctx?.ipAddress ?? 'anonymous';
    const key = this.redis.key(ctx?.organizationId, 'ratelimit', bucket.name, identity);

    const { count, ttl } = await this.redis.incrementWindow(key, bucket.windowSeconds);
    const remaining = Math.max(0, bucket.limit - count);

    const reply = context.switchToHttp().getResponse<FastifyReply>();
    void reply.header('RateLimit-Limit', String(bucket.limit));
    void reply.header('RateLimit-Remaining', String(remaining));
    void reply.header('RateLimit-Reset', String(ttl));

    if (count > bucket.limit) {
      void reply.header('Retry-After', String(ttl));
      throw new AppError('rate_limited', `Rate limit exceeded for ${bucket.name}`, {
        meta: { limit: bucket.limit, windowSeconds: bucket.windowSeconds, retryAfter: ttl },
      });
    }
    return true;
  }
}
