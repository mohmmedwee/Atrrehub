'use client';

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The frame every list and detail screen sits in.
 *
 * The screens that existed each invented their own title block and spacing, so
 * moving between them felt like moving between products. One frame is what
 * makes a set of screens read as one application.
 */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface px-5 py-3.5">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-text">{title}</h1>
        {description ? <p className="mt-0.5 text-[13px] text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="p-5">{children}</div>;
}

/**
 * An empty state that offers the way out.
 *
 * The ones this replaces were a centred sentence and nothing else — a dead end
 * at exactly the moment somebody needs to be told what to do next.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  hint,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /** A keyboard route to the same thing, for people who prefer one. */
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {Icon ? (
        <span
          aria-hidden="true"
          className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-surface-sunken text-text-muted"
        >
          <Icon size={20} />
        </span>
      ) : null}
      <p className="text-sm font-medium text-text">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
      {hint ? <p className="mt-3 text-[11px] text-text-muted">{hint}</p> : null}
    </div>
  );
}

/** A row of filter chips. Selected state is never colour alone. */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  counts,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist">
      {options.map((option) => {
        const active = option.value === value;
        const count = counts?.[option.value];
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1 text-[13px] transition-colors duration-fast ${
              active
                ? 'bg-accent/10 font-medium text-accent'
                : 'text-text-muted hover:bg-surface-sunken hover:text-text'
            }`}
          >
            {option.label}
            {count === undefined ? null : (
              <span className={`ml-1.5 tabular-nums ${active ? 'text-accent' : 'text-text-muted'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The card every panel uses — one border radius, one padding rhythm. */
export function Panel({
  title,
  actions,
  children,
  padded = true,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface">
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-text">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}
