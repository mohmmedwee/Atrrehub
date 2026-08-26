import { INestApplication } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/core/errors/exception.filter';
import { AppLogger } from '../src/core/logger/logger.service';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { RedisService } from '../src/core/redis/redis.service';

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  redis: RedisService;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any }>;
}

/**
 * Boots the real application against the real database.
 *
 * Integration tests that stub the database prove the stubs work; these run the
 * whole stack, which is the only way to verify things like tenant isolation
 * that live in the query layer.
 */
export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: true }),
    {
      bufferLogs: true,
    },
  );
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'metrics'] });
  app.useGlobalFilters(new AllExceptionsFilter(app.get(AppLogger)));

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  const request: TestContext['request'] = async (method, path, options = {}) => {
    const response = await app.inject({
      method: method as never,
      // `/api/` — not `/api`, which would also match a route named `/api-keys`.
      url: path.startsWith('/api/') ? path : `/api/v1${path}`,
      payload: options.body as never,
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
    });
    const text = response.body;
    return { status: response.statusCode, body: text ? JSON.parse(text) : undefined };
  };

  return { app, prisma, redis, request };
}

export async function closeTestApp(context: TestContext): Promise<void> {
  await context.app.close();
}

let counter = 0;

/**
 * A fresh tenant per test, so tests never contend over shared fixtures.
 *
 * Registration goes through the `auth` rate-limit bucket, which a test suite
 * legitimately exceeds. The window is cleared first — the limiter itself is
 * covered by its own test rather than by getting in the way of every other one.
 */
export async function registerTenant(context: TestContext, label = 'test') {
  await clearRateLimits(context);
  counter += 1;
  const suffix = `${Date.now().toString(36)}${counter}`;
  const email = `${label}-${suffix}@isolation.test`;

  const { status, body } = await context.request('POST', '/auth/register', {
    body: {
      email,
      password: 'Str0ngPassword!23',
      firstName: 'Test',
      lastName: 'Owner',
      organizationName: `${label} ${suffix}`,
    },
  });

  if (status !== 201 && status !== 200) {
    throw new Error(`Could not register a test tenant: ${JSON.stringify(body)}`);
  }

  return {
    email,
    password: 'Str0ngPassword!23',
    token: body.data.accessToken as string,
    refreshToken: body.data.refreshToken as string,
    organizationId: body.data.organization.id as string,
    userId: body.data.user.id as string,
  };
}

/** Clear every rate-limit window so suites do not throttle each other. */
export async function clearRateLimits(context: TestContext): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await context.redis.client.scan(
      cursor,
      'MATCH',
      'atr:*:ratelimit:*',
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length) await context.redis.client.del(...keys);
  } while (cursor !== '0');
}
