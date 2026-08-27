import { Global, Module } from '@nestjs/common';
import { WfmController } from './wfm.controller';
import { WfmListener } from './wfm.listener';
import { WfmService } from './wfm.service';

@Global()
@Module({
  controllers: [WfmController],
  providers: [WfmService, WfmListener],
  exports: [WfmService],
})
export class WfmModule {}
