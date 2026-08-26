import { Global, Module } from '@nestjs/common';
import { RoutingController } from './routing.controller';
import { RoutingListener } from './routing.listener';
import { RoutingService } from './routing.service';

@Global()
@Module({
  controllers: [RoutingController],
  providers: [RoutingService, RoutingListener],
  exports: [RoutingService],
})
export class RoutingModule {}
