import { Global, Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { DrController } from './dr.controller';

@Global()
@Module({
  controllers: [DrController],
  providers: [BackupService],
  exports: [BackupService],
})
export class DrModule {}
