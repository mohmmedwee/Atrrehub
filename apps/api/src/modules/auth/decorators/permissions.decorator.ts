import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../permissions';

export const PERMISSIONS_KEY = 'auth:permissions';
export const PERMISSIONS_MODE_KEY = 'auth:permissions_mode';

/** Requires every listed permission. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Requires at least one of the listed permissions. */
export function RequireAnyPermission(...permissions: Permission[]) {
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    SetMetadata(PERMISSIONS_KEY, permissions)(
      target,
      key as string,
      descriptor as PropertyDescriptor,
    );
    SetMetadata(PERMISSIONS_MODE_KEY, 'any')(
      target,
      key as string,
      descriptor as PropertyDescriptor,
    );
  };
}
