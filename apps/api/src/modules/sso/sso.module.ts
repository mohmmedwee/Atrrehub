import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';
import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [SsoController, ScimController],
  providers: [SsoService, ScimService],
  exports: [SsoService, ScimService],
})
export class SsoModule {}
