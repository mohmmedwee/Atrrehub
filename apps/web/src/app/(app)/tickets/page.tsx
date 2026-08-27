'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Search, Ticket as TicketIcon } from 'lucide-react';
import { get, type Paginated } from '@/lib/api';
import { priorityTone, relativeTime, statusTone } from '@/lib/format';
import { Badge, Spinner, inputClass } from '@/components/ui';
import { DataTable, type Column } from '@/components/data-table';
import { EmptyState, FilterChips, PageHeader } from '@/components/page';

/**
 * Tickets.
 *
 * The API has served these since the ticketing phase shipped; there has never
 * been a screen. An agent could create a ticket from a conversation and then
 * had no way to find it again, which made the whole capability invisible.
 */

interface Ticket {
  id: string;
  number: number;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  assigneeId: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; displayName: string | null } | null;
}

type Scope = 'open' | 'overdue' | 'unassigned' | 'all';

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'all', label: 'All' },
];

export default function TicketsPage() {
  const [scope, setScope] = useState<Scope>('open');
  const [term, setTerm] = useState('');

  const query = useMemo(() => {
    const params: Record<string, string | number> = { limit: 100 };
    if (scope === 'open') params.open = 'true';
    if (scope === 'overdue') params.overdue = 'true';
    if (term.trim()) params.q = term.trim();
    return params;
  }, [scope, term]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['tickets', query],
    queryFn: () => get<Paginated<Ticket>>('/tickets', query),
    // A stale list on a screen an agent leaves open all day is worse than a
    // brief spinner, but refetching on every focus change is noise.
    refetchInterval: 30_000,
  });

  // Unassigned has no server-side filter, so it is applied here rather than
  // sending an assigneeId nobody has.
  const rows = useMemo(() => {
    const all = data?.data ?? [];
    return scope === 'unassigned' ? all.filter((ticket) => !ticket.assigneeId) : all;
  }, [data, scope]);

  const columns: Column<Ticket>[] = [
    {
      key: 'reference',
      header: 'Ref',
      width: '90px',
      sortBy: (row) => row.number,
      render: (row) => <span className="tabular-nums text-text-muted">{row.reference}</span>,
    },
    {
      key: 'subject',
      header: 'Subject',
      sortBy: (row) => row.subject,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-text">{row.subject}</p>
          {row.customer?.displayName ? (
            <p className="truncate text-xs text-text-muted">{row.customer.displayName}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      sortBy: (row) => row.status,
      render: (row) => <Badge tone={statusTone[row.status] ?? 'muted'}>{row.status}</Badge>,
    },
    {
      key: 'priority',
      header: 'Priority',
      width: '110px',
      sortBy: (row) => row.priority,
      render: (row) => <Badge tone={priorityTone[row.priority] ?? 'muted'}>{row.priority}</Badge>,
    },
    {
      key: 'dueAt',
      header: 'Due',
      width: '130px',
      sortBy: (row) => (row.dueAt ? Date.parse(row.dueAt) : null),
      render: (row) => {
        if (!row.dueAt) return <span className="text-text-muted">—</span>;
        const overdue = Date.parse(row.dueAt) < Date.now() && !row.resolvedAt;
        return (
          <span className={overdue ? 'font-medium text-danger' : 'text-text-muted'}>
            {overdue ? '⚠ ' : ''}
            {relativeTime(row.dueAt)}
          </span>
        );
      },
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      width: '130px',
      sortBy: (row) => Date.parse(row.updatedAt),
      render: (row) => <span className="text-text-muted">{relativeTime(row.updatedAt)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Work that outlives a single conversation."
        actions={
          <div className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search tickets"
              aria-label="Search tickets"
              className={`${inputClass} w-56 pl-8`}
            />
          </div>
        }
      />

      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-2">
        <FilterChips options={SCOPES} value={scope} onChange={setScope} />
        <p className="text-xs text-text-muted">
          {isLoading ? '' : `${rows.length} ticket${rows.length === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="p-5">
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {isLoading ? (
            <Spinner label="Loading tickets" />
          ) : isError ? (
            <EmptyState
              icon={TicketIcon}
              title="Tickets could not be loaded"
              description="The request failed. This is usually a connection problem rather than a permissions one."
            />
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(row) => row.id}
              defaultSort="updatedAt"
              empty={
                <EmptyState
                  icon={TicketIcon}
                  title={
                    term
                      ? `No tickets match “${term}”`
                      : `Nothing ${scope === 'all' ? 'here' : scope}`
                  }
                  description={
                    term
                      ? 'Try a shorter search, or clear it to see everything in this view.'
                      : 'Tickets are created from a conversation, by automation, or through the API.'
                  }
                  hint={
                    scope !== 'all' && !term
                      ? 'Switch to “All” to include resolved and closed.'
                      : undefined
                  }
                />
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
