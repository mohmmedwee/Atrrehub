import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { buildConfig } from './config/configuration';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './core/core.module';
import { AllExceptionsFilter } from './core/errors/exception.filter';
import { ApiLogInterceptor } from './core/http/api-log.interceptor';
import { IdempotencyInterceptor } from './core/http/idempotency.interceptor';
import { MetricsInterceptor } from './core/http/metrics.interceptor';
import { RateLimitGuard } from './core/http/rate-limit.guard';
import { RequestContextMiddleware } from './core/http/request-context.middleware';
import { ResponseEnvelopeInterceptor } from './core/http/response.interceptor';
import { AgentsModule } from './modules/agents/agents.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AutomationModule } from './modules/automation/automation.module';
import { IntelligenceModule } from './modules/intelligence/intelligence.module';
import { QualityModule } from './modules/quality/quality.module';
import { CopilotModule } from './modules/copilot/copilot.module';
import { GuardrailsModule } from './modules/guardrails/guardrails.module';
import { MemoryModule } from './modules/memory/memory.module';
import { ToolsModule } from './modules/tools/tools.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { AiModule } from './modules/ai/ai.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { IamModule } from './modules/iam/iam.module';
import { AuthGuard } from './modules/auth/guards/auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { RagModule } from './modules/rag/rag.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RoutingModule } from './modules/routing/routing.module';
import { SlaModule } from './modules/sla/sla.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { WidgetModule } from './modules/widget/widget.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../.env'],
      load: [() => buildConfig(validateEnv(process.env))],
    }),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', maxListeners: 50, verboseMemoryLeak: false }),
    ScheduleModule.forRoot(),
    CoreModule,
    AuditModule,
    TenancyModule,
    AuthModule,
    IamModule,
    DirectoryModule,
    CustomersModule,
    RealtimeModule,
    ChannelsModule,
    ConversationsModule,
    TicketsModule,
    SlaModule,
    RoutingModule,
    AiModule,
    RagModule,
    KnowledgeModule,
    GuardrailsModule,
    ToolsModule,
    MemoryModule,
    WorkflowsModule,
    AgentsModule,
    CopilotModule,
    AutomationModule,
    IntelligenceModule,
    QualityModule,
    AnalyticsModule,
    WidgetModule,
  ],
  providers: [
    // Order matters: authenticate, then authorize, then meter.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ApiLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
