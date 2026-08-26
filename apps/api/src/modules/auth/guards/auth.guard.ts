import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { RequestContextStore, type Principal } from '../../../core/context/request-context';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { AppError } from '../../../core/errors/app-error';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { RedisService } from '../../../core/redis/redis.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface AccessTokenClaims {
  sub: string;
  org: string;
  wks?: string;
  role: string;
  perms: string[];
  owner?: boolean;
  mfa?: boolean;
  typ: 'access';
}

/**
 * Resolves the principal and the tenant for every request.
 *
 * Three credential types are accepted — a bearer access token, an API key, and
 * a widget token — and each yields the same `Principal` shape so authorization
 * downstream never has to care how the caller authenticated.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const headers = request.headers as Record<string, string | undefined>;

    const resolved =
      (await this.fromBearer(headers)) ??
      (await this.fromApiKey(headers)) ??
      (await this.fromWidgetToken(headers));

    if (resolved) {
      const workspaceId = this.resolveWorkspace(headers, resolved);
      RequestContextStore.patch({
        principal: resolved.principal,
        organizationId: resolved.organizationId,
        workspaceId,
      });
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    throw AppError.unauthenticated();
  }

  /** An explicit workspace header wins, but only if the principal may use it. */
  private resolveWorkspace(
    headers: Record<string, string | undefined>,
    resolved: { principal: Principal; workspaceId?: string },
  ): string | undefined {
    const requested = headers['x-workspace-id'];
    if (!requested) return resolved.workspaceId;
    const pinned = resolved.principal.workspaceIds;
    if (pinned?.length && !pinned.includes(requested)) {
      throw AppError.permissionDenied('workspace:access');
    }
    return requested;
  }

  private async fromBearer(headers: Record<string, string | undefined>) {
    const header = headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7));
    } catch {
      throw AppError.unauthenticated('The access token is invalid or has expired');
    }
    if (claims.typ !== 'access') throw AppError.unauthenticated('Wrong token type');

    // A revoked session must stop working before its token expires.
    if (await this.redis.client.get(`atr:global:revoked-user:${claims.sub}`)) {
      throw AppError.unauthenticated('This session has been revoked');
    }

    const requestedOrg = headers['x-organization-id'];
    if (requestedOrg && requestedOrg !== claims.org) {
      // Switching tenants requires a token minted for that tenant.
      throw AppError.permissionDenied('organization:access');
    }

    const principal: Principal = {
      type: 'user',
      id: claims.sub,
      permissions: claims.perms,
      isOwner: claims.owner,
      roleKey: claims.role,
      workspaceIds: undefined,
    };
    return { principal, organizationId: claims.org, workspaceId: claims.wks };
  }

  private async fromApiKey(headers: Record<string, string | undefined>) {
    const raw = headers['x-api-key'];
    if (!raw?.startsWith('ak_')) return null;

    const record = await this.prisma.raw.apiKey.findUnique({
      where: { keyHash: this.crypto.hashToken(raw) },
    });
    if (!record || record.revokedAt || (record.expiresAt && record.expiresAt < new Date())) {
      throw AppError.unauthenticated('The API key is invalid, revoked or expired');
    }

    // Touch at most once a minute — this is telemetry, not an audit record.
    const touchKey = `atr:global:apikey-touch:${record.id}`;
    if (await this.redis.client.set(touchKey, '1', 'EX', 60, 'NX')) {
      void this.prisma.raw.apiKey
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    const principal: Principal = {
      type: 'api_key',
      id: record.id,
      label: record.name,
      permissions: record.permissions,
    };
    return { principal, organizationId: record.organizationId, workspaceId: undefined };
  }

  private async fromWidgetToken(headers: Record<string, string | undefined>) {
    const token = headers['x-widget-token'];
    if (!token) return null;

    let claims: { org: string; cha: string; cus?: string; cnv?: string; typ: string };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw AppError.unauthenticated('The widget token is invalid or has expired');
    }
    if (claims.typ !== 'widget') throw AppError.unauthenticated('Wrong token type');

    // Widget sessions can only act on their own conversation, enforced by the
    // widget controller; the permission set here is deliberately minimal.
    const principal: Principal = {
      type: 'widget',
      id: claims.cus ?? claims.cha,
      permissions: ['conversation:create', 'message:create'],
    };
    return { principal, organizationId: claims.org, workspaceId: undefined };
  }
}
