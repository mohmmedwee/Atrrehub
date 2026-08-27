import { Global, Module } from '@nestjs/common';
import { AccessReviewService } from './access-review.service';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { SubjectRightsService } from './subject-rights.service';

@Global()
@Module({
  controllers: [GovernanceController],
  providers: [GovernanceService, SubjectRightsService, AccessReviewService],
  exports: [GovernanceService, SubjectRightsService, AccessReviewService],
})
export class GovernanceModule {}
