import { Global, Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiGateway } from './gateway.service';

/** Global: the gateway is the only route to a provider, from anywhere. */
@Global()
@Module({
  controllers: [AiController],
  providers: [AiGateway],
  exports: [AiGateway],
})
export class AiModule {}
