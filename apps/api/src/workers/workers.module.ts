import { Module } from '@nestjs/common';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { WorkersService } from './workers.service';

@Module({ imports: [TenancyModule], providers: [WorkersService] })
export class WorkersModule {}
