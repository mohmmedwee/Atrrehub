import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { RequestContextStore, type Principal } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiZodBody } from '../../core/http/zod-openapi';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { PrismaService } from '../../core/prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  ChangePasswordSchema,
  EnableMfaSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RefreshSchema,
  RegisterSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from './dto/auth.dto';

@ApiTags('Authentication')
@Controller('auth')
@RateLimit(RATE_BUCKETS.auth)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenancy: TenancyService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and its organization' })
  @ApiZodBody(RegisterSchema)
  async register(@Body(zodBody(RegisterSchema)) body: z.infer<typeof RegisterSchema>) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiZodBody(LoginSchema)
  async login(@Body(zodBody(LoginSchema)) body: z.infer<typeof LoginSchema>) {
    return this.auth.login(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for a new session' })
  @ApiZodBody(RefreshSchema)
  async refresh(@Body(zodBody(RefreshSchema)) body: z.infer<typeof RefreshSchema>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the presented refresh token' })
  @ApiZodBody(RefreshSchema)
  async logout(@Body(zodBody(RefreshSchema)) body: z.infer<typeof RefreshSchema>) {
    await this.auth.logout(body.refreshToken);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a password reset link' })
  @ApiZodBody(ForgotPasswordSchema)
  async forgotPassword(
    @Body(zodBody(ForgotPasswordSchema)) body: z.infer<typeof ForgotPasswordSchema>,
  ) {
    await this.auth.forgotPassword(body.email);
    return { accepted: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  @ApiZodBody(ResetPasswordSchema)
  async resetPassword(
    @Body(zodBody(ResetPasswordSchema)) body: z.infer<typeof ResetPasswordSchema>,
  ) {
    await this.auth.resetPassword(body.token, body.password);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email address' })
  @ApiZodBody(VerifyEmailSchema)
  async verifyEmail(@Body(zodBody(VerifyEmailSchema)) body: z.infer<typeof VerifyEmailSchema>) {
    await this.auth.verifyEmail(body.token);
  }

  @Get('me')
  @RateLimit(RATE_BUCKETS.api)
  @ApiOperation({ summary: 'The authenticated principal, tenant and permissions' })
  async me(@CurrentUser() principal: Principal | undefined) {
    if (!principal) throw AppError.unauthenticated();
    const organizationId = RequestContextStore.organizationId()!;

    if (principal.type !== 'user') {
      return {
        principal: { type: principal.type, id: principal.id, label: principal.label },
        organization: await this.tenancy.getOrganization(organizationId),
        permissions: principal.permissions,
      };
    }

    const user = await this.prisma.raw.user.findUniqueOrThrow({
      where: { id: principal.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        locale: true,
        timezone: true,
        presence: true,
        mfaEnabled: true,
        emailVerifiedAt: true,
        skills: true,
        languages: true,
      },
    });

    return {
      user,
      organization: await this.tenancy.getOrganization(organizationId),
      organizations: await this.tenancy.listForUser(principal.id),
      role: principal.roleKey,
      permissions: principal.permissions,
      isOwner: principal.isOwner ?? false,
    };
  }

  @Post('change-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change the current password' })
  @ApiZodBody(ChangePasswordSchema)
  async changePassword(
    @CurrentUser() principal: Principal | undefined,
    @Body(zodBody(ChangePasswordSchema)) body: z.infer<typeof ChangePasswordSchema>,
  ) {
    this.requireUser(principal);
    await this.auth.changePassword(principal!.id, body.currentPassword, body.newPassword);
  }

  @Get('sessions')
  @RateLimit(RATE_BUCKETS.api)
  @ApiOperation({ summary: 'List active sessions' })
  async sessions(@CurrentUser() principal: Principal | undefined) {
    this.requireUser(principal);
    return this.auth.listSessions(principal!.id);
  }

  @Delete('sessions')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of every device' })
  async revokeSessions(@CurrentUser() principal: Principal | undefined) {
    this.requireUser(principal);
    await this.auth.revokeAllSessions(principal!.id, 'user_requested');
  }

  @Post('mfa/setup')
  @ApiOperation({ summary: 'Begin TOTP enrolment' })
  async beginMfa(@CurrentUser() principal: Principal | undefined) {
    this.requireUser(principal);
    const user = await this.prisma.raw.user.findUniqueOrThrow({ where: { id: principal!.id } });
    return this.auth.beginMfaSetup(user.id, user.email);
  }

  @Post('mfa/confirm')
  @ApiOperation({ summary: 'Confirm TOTP enrolment and receive recovery codes' })
  @ApiZodBody(EnableMfaSchema)
  async confirmMfa(
    @CurrentUser() principal: Principal | undefined,
    @Body(zodBody(EnableMfaSchema)) body: z.infer<typeof EnableMfaSchema>,
  ) {
    this.requireUser(principal);
    return this.auth.confirmMfaSetup(principal!.id, body.code);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disable multi-factor authentication' })
  @ApiZodBody(EnableMfaSchema)
  async disableMfa(
    @CurrentUser() principal: Principal | undefined,
    @Body(zodBody(EnableMfaSchema)) body: z.infer<typeof EnableMfaSchema>,
  ) {
    this.requireUser(principal);
    await this.auth.disableMfa(principal!.id, body.code);
  }

  /** API keys and widget tokens have no password or MFA to manage. */
  private requireUser(principal: Principal | undefined): void {
    if (!principal) throw AppError.unauthenticated();
    if (principal.type !== 'user') {
      throw AppError.permissionDenied('This endpoint requires an interactive user session');
    }
  }
}
