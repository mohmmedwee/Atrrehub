'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { get, post, tokens } from '@/lib/api';
import { disconnectRealtime, realtime } from '@/lib/realtime';
import { visibleGroups } from '@/lib/navigation';
import { Avatar, Spinner } from '@/components/ui';
import { CommandPalette, openCommandPalette } from '@/components/command-palette';
import { PresenceMenu } from '@/components/presence-menu';
import type { Me } from '@/lib/types';

const COLLAPSE_KEY = 'atrrehub:sidebar-collapsed';

/**
 * The application shell.
 *
 * A sidebar rather than a row of tabs, because the product has two dozen
 * surfaces and a tab row can hold four. Everything beyond those four used to
 * be unreachable — not unfinished, unreachable — which made the API's breadth
 * invisible to the person using it.
 */
export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const {
    data: me,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/auth/me'),
    retry: false,
  });

  // Read after mount, not during render: the server has no localStorage and a
  // mismatch here is a hydration error on every page load.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* private browsing, or storage disabled — the default is fine */
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* the preference simply will not persist */
      }
      return next;
    });
  }

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

  const groups = visibleGroups(me.permissions);

  return (
    <div className="flex h-screen overflow-hidden bg-surface-sunken">
      <CommandPalette permissions={me.permissions} />

      <aside
        className={`hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-base md:flex ${
          collapsed ? 'w-[60px]' : 'w-[212px]'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 px-3">
          <Link
            href="/workspace"
            className="flex items-center gap-2 overflow-hidden text-sm font-semibold tracking-tight"
          >
            <span
              aria-hidden="true"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-[13px] font-bold text-accent-fg"
            >
              A
            </span>
            {collapsed ? null : <span className="truncate">Atrrehub</span>}
          </Link>
        </div>

        {collapsed ? null : (
          <button
            onClick={openCommandPalette}
            className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs text-text-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-text"
          >
            <Search size={13} aria-hidden="true" />
            <span className="flex-1">Search</span>
            <kbd className="rounded border border-border px-1 text-[10px]">⌘K</kbd>
          </button>
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Primary">
          {groups.map((group) => (
            <div key={group.label} className="mb-3">
              {collapsed ? (
                <div className="mx-2 mb-1.5 border-t border-border" role="presentation" />
              ) : (
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname.startsWith(item.href);
                  const planned = item.status === 'planned';
                  const Icon = item.icon;

                  const inner = (
                    <>
                      <Icon size={15} className="shrink-0" aria-hidden="true" />
                      {collapsed ? null : <span className="truncate">{item.label}</span>}
                    </>
                  );
                  const shape =
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-fast';

                  return (
                    <li key={item.href}>
                      {planned ? (
                        // Shown, not hidden: an operator learns the capability
                        // exists and is coming, instead of assuming it does not.
                        <span
                          title={`${item.label} — API is ready, screen is not built yet`}
                          aria-disabled="true"
                          className={`${shape} cursor-not-allowed text-text-muted opacity-45`}
                        >
                          {inner}
                        </span>
                      ) : (
                        <Link
                          href={item.href}
                          title={collapsed ? item.label : undefined}
                          aria-current={active ? 'page' : undefined}
                          className={`${shape} ${
                            active
                              ? 'bg-accent/10 font-medium text-accent'
                              : 'text-text-muted hover:bg-surface-sunken hover:text-text'
                          }`}
                        >
                          {inner}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex shrink-0 items-center gap-2.5 border-t border-border px-4 py-2 text-[13px] text-text-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-text"
        >
          {collapsed ? (
            <PanelLeftOpen size={15} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={15} aria-hidden="true" />
          )}
          {collapsed ? null : <span>Collapse</span>}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4">
          <span className="truncate text-sm font-medium text-text">{me.organization.name}</span>

          <div className="flex items-center gap-3">
            <PresenceMenu current={me.user.presence} />
            <Avatar
              name={`${me.user.firstName} ${me.user.lastName}`}
              url={me.user.avatarUrl}
              size={26}
            />
            <button
              onClick={signOut}
              className="text-xs text-text-muted transition-colors duration-fast hover:text-text"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
