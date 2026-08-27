import { Global, Module } from '@nestjs/common';
import { HybridController } from './hybrid.controller';
import { HybridService } from './hybrid.service';

@Global()
@Module({
  controllers: [HybridController],
  providers: [HybridService],
  exports: [HybridService],
})
export class HybridModule {}
