'use client';

import type { ReactNode } from 'react';

/**
 * The shared primitives. Every one takes a semantic tone rather than a colour,
 * so branding and theming happen entirely through the token layer.
 */

type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

const toneClasses: Record<Tone, string> = {
  accent: 'bg-accent/10 text-accent border-accent/25',
  success: 'bg-success/10 text-success border-success/25',
  warning: 'bg-warning/10 text-warning border-warning/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  info: 'bg-info/10 text-info border-info/25',
  muted: 'bg-surface-sunken text-text-muted border-border',
};

export function Badge({
  children,
  tone = 'muted',
  icon,
}: {
  children: ReactNode;
  tone?: Tone | string;
  icon?: string;
}) {
  const resolved = toneClasses[tone as Tone] ?? toneClasses.muted;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium ${resolved}`}
    >
      {/* Status is never encoded by colour alone. */}
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled,
  type = 'button',
  title,
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  full?: boolean;
}) {
  const variants = {
    primary: 'bg-accent text-accent-fg hover:opacity-90 border-transparent',
    secondary: 'bg-surface-raised text-text border-border hover:bg-surface-sunken',
    ghost:
      'bg-transparent text-text-muted border-transparent hover:bg-surface-sunken hover:text-text',
    danger: 'bg-danger text-white border-transparent hover:opacity-90',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50 ${
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'
      } ${variants[variant]} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`rounded-lg border border-border bg-surface ${className}`}>
      {title ? (
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ? `text-${tone}` : ''}`}>
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-text-muted">{sub}</p> : null}
    </div>
  );
}

export function Avatar({
  name,
  url,
  size = 32,
}: {
  name: string | null;
  url?: string | null;
  size?: number;
}) {
  const label = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={name ?? ''}
      width={size}
      height={size}
      className="rounded-full object-cover"
    />
  ) : (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent"
    >
      {label}
    </span>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-text">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-text-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 px-6 py-10 text-text-muted"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent"
        aria-hidden="true"
      />
      <span className="text-xs">{label}…</span>
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="m-4 rounded-md border border-danger/30 bg-danger/5 p-4">
      <p className="text-sm font-medium text-danger">{message}</p>
      {retry ? (
        <div className="mt-2">
          <Button size="sm" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none';
