import { Global, Module } from '@nestjs/common';
import { DeadLetterService } from './dead-letter.service';
import { PartitionService } from './partition.service';
import { ResilienceController } from './resilience.controller';

@Global()
@Module({
  controllers: [ResilienceController],
  providers: [DeadLetterService, PartitionService],
  exports: [DeadLetterService, PartitionService],
})
export class ResilienceModule {}
