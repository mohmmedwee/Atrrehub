'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { get, post, tokens } from '@/lib/api';
import { disconnectRealtime, realtime } from '@/lib/realtime';
import { Avatar, Spinner } from '@/components/ui';
import type { Me } from '@/lib/types';

const NAV = [
  { href: '/workspace', label: 'Workspace', permission: 'conversation:read' },
  { href: '/ai', label: 'AI Studio', permission: 'agent:read' },
  { href: '/analytics', label: 'Analytics', permission: 'analytics:read' },
  { href: '/admin', label: 'Admin', permission: 'organization:read' },
];

/** True when the granted set satisfies `required`, mirroring the server rule. */
function allows(granted: string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  return granted.includes(`${required.split(':')[0]}:manage`);
}

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const { data: me, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/auth/me'),
    retry: false,
  });

  useEffect(() => {
    if (isError) router.replace('/login');
  }, [isError, router]);

  // The socket lives as long as the shell, not the screen inside it.
  useEffect(() => {
    if (!me) return;
    realtime();
    return () => disconnectRealtime();
  }, [me]);

  async function signOut() {
    const refreshToken = tokens.refresh();
    if (refreshToken) await post('/auth/logout', { refreshToken }).catch(() => undefined);
    tokens.clear();
    disconnectRealtime();
    router.replace('/login');
  }

  if (isLoading) return <Spinner label="Loading your workspace" />;
  if (!me) return null;

  const visible = NAV.filter((item) => allows(me.permissions, item.permission));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-6">
          <Link href="/workspace" className="text-sm font-semibold tracking-tight">
            Atrrehub
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {visible.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-md px-2.5 py-1 text-sm transition-colors duration-fast ${
                    active ? 'bg-accent/10 font-medium text-accent' : 'text-text-muted hover:bg-surface-sunken hover:text-text'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-text-muted sm:inline">{me.organization.name}</span>
          <PresenceToggle current={me.user.presence} />
          <Avatar name={`${me.user.firstName} ${me.user.lastName}`} url={me.user.avatarUrl} size={26} />
          <button onClick={signOut} className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline">
            Sign out
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** Availability drives routing, so it belongs where an agent always sees it. */
function PresenceToggle({ current }: { current: string }) {
  const options = ['available', 'busy', 'away', 'on_break', 'offline'];
  const tone: Record<string, string> = {
    available: 'text-success',
    busy: 'text-warning',
    away: 'text-text-muted',
    on_break: 'text-text-muted',
    offline: 'text-text-muted',
  };

  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Availability</span>
      <span aria-hidden="true" className={tone[current] ?? 'text-text-muted'}>
        ●
      </span>
      <select
        defaultValue={current}
        onChange={(event) => post('/me/presence', { presence: event.target.value }).catch(() => undefined)}
        className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}
