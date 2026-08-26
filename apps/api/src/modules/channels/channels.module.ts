import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { EmailAdapter } from './adapters/email.adapter';
import { WebChatAdapter } from './adapters/web-chat.adapter';
import { ChannelRegistry } from './channel-registry.service';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

/**
 * Channel adapters register themselves at boot. Adding a channel means adding
 * an adapter here — nothing in the interaction engine changes.
 */
@Global()
@Module({
  // Both this module and ConversationsModule are global, so they reach each
  // other's exported providers without importing one another — importing would
  // form a cycle at module-definition time.
  controllers: [ChannelsController],
  providers: [ChannelRegistry, ChannelsService, WebChatAdapter, EmailAdapter],
  exports: [ChannelsService, ChannelRegistry],
})
export class ChannelsModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly webChat: WebChatAdapter,
    private readonly email: EmailAdapter,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.webChat);
    this.registry.register(this.email);
  }
}
