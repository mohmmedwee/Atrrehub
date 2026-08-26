import { Global, Module } from '@nestjs/common';
import { QualityController } from './quality.controller';
import { QualityListener } from './quality.listener';
import { QualityService } from './quality.service';

@Global()
@Module({
  controllers: [QualityController],
  providers: [QualityService, QualityListener],
  exports: [QualityService],
})
export class QualityModule {}
