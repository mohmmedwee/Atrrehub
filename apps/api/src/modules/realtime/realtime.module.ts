import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/** Global: any module may push realtime updates to the workspace or widget. */
@Global()
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
