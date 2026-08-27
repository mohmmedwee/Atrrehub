import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';

/**
 * Everything inside this route group renders in the application shell.
 *
 * A route group rather than a layout file per route: the per-route version was
 * five identical lines copied into each directory, and a new screen that
 * forgot to copy them rendered with no navigation at all — which is silent,
 * because the page itself looks fine.
 *
 * Routes that must not have the shell — the login page, the widget demo —
 * simply live outside this group.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
