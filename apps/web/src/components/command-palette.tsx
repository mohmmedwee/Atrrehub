'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { flatItems, type NavItem } from '@/lib/navigation';

/**
 * ⌘K navigation.
 *
 * An operator tool is used all day by people who learn it once. Making them
 * reach for a mouse to change surface is the difference between a tool that
 * feels fast and one that feels like a website — and with two dozen surfaces,
 * a sidebar alone means scanning a list every time.
 */

const OPEN_EVENT = 'atrrehub:open-command-palette';

/** Open the palette from a click, so the button and ⌘K share one path. */
export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

interface Command {
  id: string;
  label: string;
  group: string;
  keywords: string;
  disabled?: boolean;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ permissions }: { permissions: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo<Command[]>(() => {
    const navigate = (item: NavItem): Command => ({
      id: item.href,
      label: item.label,
      group: 'Go to',
      keywords: `${item.label} ${item.keywords ?? ''} ${item.href}`.toLowerCase(),
      disabled: item.status === 'planned',
      hint: item.status === 'planned' ? 'not built yet' : undefined,
      run: () => router.push(item.href),
    });
    return flatItems(permissions).map(navigate);
  }, [permissions, router]);

  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return commands;
    // Every term must appear somewhere, so "gov pol" finds AI Governance
    // without needing the words adjacent or in order.
    const terms = term.split(/\s+/);
    return commands.filter((command) => terms.every((part) => command.keywords.includes(part)));
  }, [commands, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (event.key === 'Escape') setOpen(false);
    }
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    // Focus after paint, or the input is not in the document yet.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // The cursor must stay inside the result set as it shrinks under typing.
  useEffect(
    () => setCursor((current) => Math.min(current, Math.max(0, results.length - 1))),
    [results.length],
  );

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  function choose(command: Command) {
    if (command.disabled) return;
    setOpen(false);
    command.run();
  }

  function onInputKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setCursor((current) => (current + 1) % Math.max(1, results.length));
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setCursor((current) => (current - 1 + results.length) % Math.max(1, results.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = results[cursor];
      if (command) choose(command);
    }
  }

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <Search size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Go to…"
            aria-label="Search commands"
            className="w-full bg-transparent py-3 text-sm text-text outline-none placeholder:text-text-muted"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted">
            esc
          </kbd>
        </div>

        <ul ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-text-muted">
              Nothing matches “{query}”.
            </li>
          ) : (
            results.map((command, index) => {
              const header = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              const active = index === cursor;
              return (
                <li key={command.id}>
                  {header ? (
                    <p className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      {header}
                    </p>
                  ) : null}
                  <button
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    onMouseMove={() => setCursor(index)}
                    onClick={() => choose(command)}
                    disabled={command.disabled}
                    className={`flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-fast ${
                      active ? 'bg-accent/10 text-accent' : 'text-text'
                    } ${command.disabled ? 'cursor-not-allowed opacity-45' : ''}`}
                  >
                    <span>{command.label}</span>
                    {command.hint ? (
                      <span className="text-xs text-text-muted">{command.hint}</span>
                    ) : active ? (
                      <ArrowRight size={14} aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
