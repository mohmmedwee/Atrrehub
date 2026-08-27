import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { EmailAdapter } from './adapters/email.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { MessengerAdapter } from './adapters/messenger.adapter';
import { SmsAdapter } from './adapters/sms.adapter';
import { TeamsAdapter } from './adapters/teams.adapter';
import { TelegramAdapter } from './adapters/telegram.adapter';
import { WebChatAdapter } from './adapters/web-chat.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
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
  providers: [
    ChannelRegistry,
    ChannelsService,
    WebChatAdapter,
    EmailAdapter,
    WhatsAppAdapter,
    MessengerAdapter,
    InstagramAdapter,
    SmsAdapter,
    TelegramAdapter,
    TeamsAdapter,
  ],
  exports: [ChannelsService, ChannelRegistry],
})
export class ChannelsModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly webChat: WebChatAdapter,
    private readonly email: EmailAdapter,
    private readonly whatsapp: WhatsAppAdapter,
    private readonly messenger: MessengerAdapter,
    private readonly instagram: InstagramAdapter,
    private readonly sms: SmsAdapter,
    private readonly telegram: TelegramAdapter,
    private readonly teams: TeamsAdapter,
  ) {}

  onModuleInit(): void {
    for (const adapter of [
      this.webChat,
      this.email,
      this.whatsapp,
      this.messenger,
      this.instagram,
      this.sms,
      this.telegram,
      this.teams,
    ]) {
      this.registry.register(adapter);
    }
  }
}
