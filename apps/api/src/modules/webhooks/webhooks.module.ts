import { Global, Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksDispatcher } from './webhooks.dispatcher';
import { WebhooksService } from './webhooks.service';

@Global()
@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksDispatcher],
  exports: [WebhooksService],
})
export class WebhooksModule {}
