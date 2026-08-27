import 'reflect-metadata';
// Tracing first: instrumentation patches modules as they load, so anything
// imported before this line is invisible to it.
import { startTracing } from './core/telemetry/tracing';

startTracing();

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { AppLogger } from './core/logger/logger.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 26 * 1024 * 1024,
      genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    }),
    { bufferLogs: true },
  );

  // Identity providers send SCIM bodies as `application/scim+json`, which
  // Fastify does not parse by default — without this every write from a
  // provider is rejected as an unsupported media type.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      'application/scim+json',
      { parseAs: 'string' },
      (_request: unknown, body: string, done: (error: Error | null, value?: unknown) => void) => {
        try {
          done(null, body ? JSON.parse(body) : {});
        } catch (error) {
          done(error as Error);
        }
      },
    );

  const logger = app.get(AppLogger);
  app.useLogger(logger);

  const config = app.get(ConfigService<AppConfig>);
  const http = config.get('http', { infer: true })!;
  const isProduction = config.get('isProduction', { infer: true });

  // SCIM is excluded from the version prefix: identity providers are given a
  // `/scim/v2` base URL and the specification fixes the path, so a versioned
  // one would simply not be reachable by them.
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz', 'metrics', 'scim/v2/(.*)'],
  });

  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: isProduction ? undefined : false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(import('@fastify/cors'), {
    origin: (origin, callback) => {
      // Same-origin and server-to-server callers send no Origin header.
      if (!origin || http.corsOrigins.includes(origin) || http.corsOrigins.includes('*')) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed'), false);
    },
    credentials: true,
    exposedHeaders: ['x-request-id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  });

  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  });

  if (!isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Atrrehub Platform API')
        .setDescription('AI-native omnichannel customer experience and contact center platform')
        .setVersion('1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
        .addApiKey({ type: 'apiKey', name: 'X-Api-Key', in: 'header' }, 'apiKey')
        .addServer(http.publicApiUrl)
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: 'api/openapi.json',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  app.enableShutdownHooks();

  await app.listen({ port: http.port, host: http.host });
  logger.info('Atrrehub API listening', {
    url: `http://${http.host}:${http.port}`,
    docs: isProduction ? undefined : `${http.publicApiUrl}/api/docs`,
  });
}

void bootstrap();
