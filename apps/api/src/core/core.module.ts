import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppConfig } from '../config/configuration';
import { CryptoService } from './crypto/crypto.service';
import { EventBus } from './events/event-bus.service';
import { OutboxRelay } from './events/outbox.relay';
import { HealthController } from './health/health.controller';
import { AppLogger } from './logger/logger.service';
import { MailService } from './mail/mail.service';
import { MetricsService } from './metrics/metrics.service';
import { PrismaService } from './prisma/prisma.service';
import { QueueService } from './queue/queue.service';
import { RedisService } from './redis/redis.service';
import { StorageService } from './storage/storage.service';

/**
 * Cross-cutting infrastructure, available everywhere without re-importing.
 * Each service is constructed from validated config rather than reading
 * `process.env` itself, so tests can substitute configuration freely.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: AppLogger,
      useFactory: (config: ConfigService<AppConfig>) =>
        new AppLogger(
          config.get('logLevel', { infer: true }) ?? 'info',
          config.get('env', { infer: true }) === 'development',
          config.get('observability', { infer: true })?.serviceName,
        ),
      inject: [ConfigService],
    },
    {
      provide: PrismaService,
      useFactory: (logger: AppLogger, config: ConfigService<AppConfig>) =>
        new PrismaService(logger, config.get('database', { infer: true })?.url),
      inject: [AppLogger, ConfigService],
    },
    {
      provide: RedisService,
      useFactory: (config: ConfigService<AppConfig>, logger: AppLogger) =>
        new RedisService(config.get('redis', { infer: true })!.url, logger),
      inject: [ConfigService, AppLogger],
    },
    {
      provide: CryptoService,
      useFactory: (config: ConfigService<AppConfig>) =>
        new CryptoService(config.get('security', { infer: true })!.encryptionKey),
      inject: [ConfigService],
    },
    {
      provide: MetricsService,
      useFactory: (config: ConfigService<AppConfig>) =>
        new MetricsService(config.get('observability', { infer: true })?.metricsEnabled ?? true),
      inject: [ConfigService],
    },
    {
      provide: StorageService,
      useFactory: (config: ConfigService<AppConfig>, logger: AppLogger) =>
        new StorageService(config.get('storage', { infer: true })!, logger),
      inject: [ConfigService, AppLogger],
    },
    {
      provide: MailService,
      useFactory: (config: ConfigService<AppConfig>, logger: AppLogger) =>
        new MailService(config.get('mail', { infer: true })!, logger),
      inject: [ConfigService, AppLogger],
    },
    {
      provide: QueueService,
      useFactory: (config: ConfigService<AppConfig>, logger: AppLogger) => {
        const url = new URL(config.get('redis', { infer: true })!.url);
        return new QueueService(
          {
            host: url.hostname,
            port: Number(url.port || 6379),
            password: url.password || undefined,
            db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
          },
          logger,
          config.get('workers', { infer: true })!.concurrency,
        );
      },
      inject: [ConfigService, AppLogger],
    },
    {
      provide: EventBus,
      useFactory: (prisma: PrismaService, emitter: EventEmitter2, logger: AppLogger) =>
        new EventBus(prisma, emitter, logger),
      inject: [PrismaService, EventEmitter2, AppLogger],
    },
    OutboxRelay,
  ],
  exports: [
    AppLogger,
    PrismaService,
    RedisService,
    CryptoService,
    MetricsService,
    StorageService,
    MailService,
    QueueService,
    EventBus,
    OutboxRelay,
  ],
})
export class CoreModule {}
