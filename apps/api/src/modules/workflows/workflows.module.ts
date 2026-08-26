import { Global, Module } from '@nestjs/common';
import { NodeExecutors } from './nodes/node-executors';
import { RuntimeService } from './runtime.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

@Global()
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, RuntimeService, NodeExecutors],
  exports: [WorkflowsService, RuntimeService, NodeExecutors],
})
export class WorkflowsModule {}
