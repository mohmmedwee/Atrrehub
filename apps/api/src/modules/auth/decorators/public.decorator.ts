import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/** Marks a route as reachable without authentication (health, login, widget bootstrap). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
