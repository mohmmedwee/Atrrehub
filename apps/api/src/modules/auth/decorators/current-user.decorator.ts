import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { RequestContextStore, type Principal } from '../../../core/context/request-context';

/** The authenticated principal for the active request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): Principal | undefined =>
    RequestContextStore.principal(),
);

/** The resolved tenant for the active request. */
export const CurrentOrg = createParamDecorator((_data: unknown, _ctx: ExecutionContext): string => {
  const organizationId = RequestContextStore.organizationId();
  if (!organizationId) throw new Error('No organization resolved for this request');
  return organizationId;
});

export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): string | undefined => RequestContextStore.workspaceId(),
);
