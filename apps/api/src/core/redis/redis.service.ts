import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppLogger } from '../logger/logger.service';

/**
 * Redis is used for caching, rate limiting, presence, distributed locks and as
 * the BullMQ backend. Every key is prefixed with the owning tenant so a bug in
 * one module cannot serve another tenant's cached value.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  private subscriber?: Redis;

  constructor(
    private readonly url: string,
    private readonly logger: AppLogger,
  ) {
    this.client = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    this.client.on('error', (error) => this.logger.error('Redis error', error));
    this.client.on('ready', () => this.logger.info('Redis connected'));
  }

  /** A dedicated connection for pub/sub — a subscribed client cannot run commands. */
  subscriberClient(): Redis {
    this.subscriber ??= new Redis(this.url, { maxRetriesPerRequest: null });
    return this.subscriber;
  }

  key(organizationId: string | undefined, ...parts: (string | number)[]): string {
    return ['atr', organizationId ? `org:${organizationId}` : 'global', ...parts].join(':');
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) await this.client.set(key, payload, 'EX', ttlSeconds);
    else await this.client.set(key, payload);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  /** Delete every key under a prefix without blocking the server on KEYS. */
  async delByPrefix(prefix: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) removed += await this.client.del(...keys);
    } while (cursor !== '0');
    return removed;
  }

  /** Read-through cache helper. */
  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * Fixed-window counter. Returns the count after increment and the seconds
   * remaining in the window, so callers can populate RateLimit-* headers.
   */
  async incrementWindow(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttl: number }> {
    const pipeline = this.client.multi();
    pipeline.incr(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    let ttl = Number(results?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.client.expire(key, windowSeconds);
      ttl = windowSeconds;
    }
    return { count, ttl };
  }

  /**
   * Best-effort distributed lock. Returns a release function, or null when the
   * lock is already held. Callers must treat failure to acquire as "someone else
   * is doing it" rather than an error.
   */
  async acquireLock(key: string, ttlMs = 30_000): Promise<(() => Promise<void>) | null> {
    const token = Math.random().toString(36).slice(2);
    const acquired = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    if (!acquired) return null;
    return async () => {
      // Release only if we still own it, so a slow holder cannot free a newer lock.
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
      await this.client.eval(script, 1, key, token);
    };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
  }
}
