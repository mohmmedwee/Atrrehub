import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContextStore } from '../../../core/context/request-context';
import { AppError } from '../../../core/errors/app-error';
import { PERMISSIONS_KEY, PERMISSIONS_MODE_KEY } from '../decorators/permissions.decorator';
import { hasAllPermissions, hasAnyPermission, type Permission } from '../permissions';

/**
 * Deny-by-default authorization. Routes declare what they need; the guard
 * refuses anything not explicitly granted to the principal.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const principal = RequestContextStore.principal();
    if (!principal) throw AppError.unauthenticated();

    const mode = this.reflector.getAllAndOverride<string>(PERMISSIONS_MODE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const granted =
      mode === 'any'
        ? hasAnyPermission(principal.permissions, required)
        : hasAllPermissions(principal.permissions, required);

    if (!granted) throw AppError.permissionDenied(required.join(mode === 'any' ? ' | ' : ' & '));
    return true;
  }
}
