/** Presentation helpers shared across the workspace. */

export function relativeTime(value: string | Date | null | undefined, locale = 'en'): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return '—';
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function money(value: number): string {
  // AI costs are often fractions of a cent, so the usual two decimals hide them.
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Status colours are always paired with a label — never colour alone. */
export const statusTone: Record<string, string> = {
  new: 'info',
  queued: 'info',
  assigned: 'accent',
  active: 'accent',
  waiting: 'warning',
  resolved: 'success',
  closed: 'muted',
  open: 'info',
  pending: 'warning',
  on_hold: 'warning',
  reopened: 'warning',
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  suspended: 'warning',
  cancelled: 'muted',
};

export const priorityTone: Record<string, string> = {
  low: 'muted',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
  critical: 'danger',
};

export function sentimentTone(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'muted';
  if (score <= -0.3) return 'danger';
  if (score >= 0.3) return 'success';
  return 'muted';
}

export const channelLabel: Record<string, string> = {
  web_chat: 'Web chat',
  email: 'Email',
  voice: 'Voice',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
  teams: 'Teams',
  api: 'API',
};
