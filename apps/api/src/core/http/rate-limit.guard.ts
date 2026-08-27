import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../../config/configuration';
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
    private readonly config: ConfigService<AppConfig>,
  ) {}

  /**
   * The bucket's limit for this deployment.
   *
   * The constants above are sized for the default install. A capacity test, or
   * an install on much larger hardware, needs to raise them — and before this
   * existed the only way to do that was to edit the source, which meant a
   * capacity test measured the rate limiter rather than the platform.
   *
   * Floored at 1: a multiplier small enough to round a bucket to zero would
   * reject every request, including the operator's attempt to put it back.
   */
  private limitFor(bucket: RateLimitBucket): number {
    const multiplier = this.config.get('rateLimitMultiplier', { infer: true }) ?? 1;
    return Math.max(1, Math.round(bucket.limit * multiplier));
  }

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

    const limit = this.limitFor(bucket);
    const { count, ttl } = await this.redis.incrementWindow(key, bucket.windowSeconds);
    // Every one of these reads the effective limit, not the constant. A header
    // that advertises 600 while the guard enforces 6000 tells every client the
    // wrong thing to back off to.
    const remaining = Math.max(0, limit - count);

    const reply = context.switchToHttp().getResponse<FastifyReply>();
    void reply.header('RateLimit-Limit', String(limit));
    void reply.header('RateLimit-Remaining', String(remaining));
    void reply.header('RateLimit-Reset', String(ttl));

    if (count > limit) {
      void reply.header('Retry-After', String(ttl));
      throw new AppError('rate_limited', `Rate limit exceeded for ${bucket.name}`, {
        meta: { limit, windowSeconds: bucket.windowSeconds, retryAfter: ttl },
      });
    }
    return true;
  }
}
