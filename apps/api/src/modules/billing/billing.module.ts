import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { MetricsRollupService } from './metrics-rollup.service';
import { ProvisioningService } from './provisioning.service';

@Global()
@Module({
  imports: [TenancyModule],
  controllers: [BillingController],
  providers: [BillingService, MetricsRollupService, ProvisioningService],
  exports: [BillingService, MetricsRollupService, ProvisioningService],
})
export class BillingModule {}
