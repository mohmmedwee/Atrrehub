'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { post } from '@/lib/api';

/**
 * Availability drives routing, so it is the one control an agent must be able
 * to change without thinking. It was a bare `<select>`, which rendered as the
 * operating system's dropdown — the one element on the screen that ignored the
 * theme entirely, and looked broken in dark mode.
 */

const OPTIONS = [
  {
    value: 'available',
    label: 'Available',
    tone: 'bg-success',
    hint: 'Routing will assign you work',
  },
  { value: 'busy', label: 'Busy', tone: 'bg-warning', hint: 'Finishing something; no new work' },
  { value: 'away', label: 'Away', tone: 'bg-text-muted', hint: 'Away from the desk' },
  {
    value: 'on_break',
    label: 'On break',
    tone: 'bg-text-muted',
    hint: 'Counted against adherence',
  },
  { value: 'offline', label: 'Offline', tone: 'bg-text-muted', hint: 'Not working' },
] as const;

export function PresenceMenu({ current }: { current: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [presence, setPresence] = useState(current);
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // The server is the authority; a websocket update or a refetch must win over
  // whatever this component last set.
  useEffect(() => setPresence(current), [current]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const active = OPTIONS.find((option) => option.value === presence) ?? OPTIONS[4];

  async function choose(value: string) {
    const previous = presence;
    setPresence(value); // Optimistic: the control must feel instant.
    setOpen(false);
    setPending(true);
    try {
      await post('/me/presence', { presence: value });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch {
      // Rolled back rather than left lying: an agent who believes they are
      // available when the server has them offline waits for work that will
      // never arrive.
      setPresence(previous);
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Availability: ${active.label}`}
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text transition-colors duration-fast hover:bg-surface-sunken disabled:opacity-60"
      >
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${active.tone}`} />
        <span>{active.label}</span>
        <ChevronDown size={12} aria-hidden="true" className="text-text-muted" />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="Availability"
          className="absolute right-0 z-40 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {OPTIONS.map((option) => {
            const selected = option.value === presence;
            return (
              <li key={option.value}>
                <button
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(option.value)}
                  className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-fast hover:bg-surface-sunken"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${option.tone}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-text">{option.label}</span>
                    <span className="block text-[11px] text-text-muted">{option.hint}</span>
                  </span>
                  {selected ? (
                    <Check size={14} aria-hidden="true" className="mt-1 shrink-0 text-accent" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
