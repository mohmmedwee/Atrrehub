import { Global, Module } from '@nestjs/common';
import { SlaController } from './sla.controller';
import { SlaListener } from './sla.listener';
import { SlaService } from './sla.service';

@Global()
@Module({
  controllers: [SlaController],
  providers: [SlaService, SlaListener],
  exports: [SlaService],
})
export class SlaModule {}
