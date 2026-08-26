import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IamController } from './iam.controller';
import { IamService } from './iam.service';

@Module({
  imports: [AuthModule],
  controllers: [IamController],
  providers: [IamService],
  exports: [IamService],
})
export class IamModule {}
