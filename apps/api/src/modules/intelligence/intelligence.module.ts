import { Global, Module } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service';

@Global()
@Module({
  providers: [IntelligenceService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
