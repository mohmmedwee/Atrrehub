import { Global, Module, OnModuleInit } from '@nestjs/common';
import { CallsService } from './calls.service';
import { IvrService } from './ivr.service';
import { SimulatedTelephonyAdapter } from './providers/simulated.adapter';
import { SipTelephonyAdapter } from './providers/sip.adapter';
import { TwilioTelephonyAdapter } from './providers/twilio.adapter';
import { SpeechGateway } from './speech.gateway';
import { TelephonyRegistry } from './telephony-registry.service';
import { VoiceAgentService } from './voice-agent.service';
import { VoiceController } from './voice.controller';

@Global()
@Module({
  controllers: [VoiceController],
  providers: [
    CallsService,
    IvrService,
    VoiceAgentService,
    SpeechGateway,
    TelephonyRegistry,
    SimulatedTelephonyAdapter,
    TwilioTelephonyAdapter,
    SipTelephonyAdapter,
  ],
  exports: [CallsService, IvrService, VoiceAgentService, SpeechGateway, TelephonyRegistry],
})
export class VoiceModule implements OnModuleInit {
  constructor(
    private readonly registry: TelephonyRegistry,
    private readonly simulated: SimulatedTelephonyAdapter,
    private readonly twilio: TwilioTelephonyAdapter,
    private readonly sip: SipTelephonyAdapter,
  ) {}

  onModuleInit(): void {
    // The simulated provider is always registered, for the same reason the
    // local AI provider always is: the platform must run end to end with no
    // vendor account at all.
    this.registry.register(this.simulated);
    this.registry.register(this.twilio);
    this.registry.register(this.sip);
  }
}
