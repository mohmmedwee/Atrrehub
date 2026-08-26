import { Global, Module } from '@nestjs/common';
import { AutomationController } from './automation.controller';
import { AutomationListener } from './automation.listener';
import { AutomationService } from './automation.service';

@Global()
@Module({
  controllers: [AutomationController],
  providers: [AutomationService, AutomationListener],
  exports: [AutomationService],
})
export class AutomationModule {}
