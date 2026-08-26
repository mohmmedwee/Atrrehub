'use client';

import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { relativeTime, statusTone } from '@/lib/format';
import { Avatar, Badge, Spinner } from '@/components/ui';
import type { CustomerOverview } from '@/lib/types';

/** The Customer 360 rail: identity, AI context, history and activity. */
export function CustomerPanel({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer-overview', customerId],
    queryFn: () => get<CustomerOverview>(`/customers/${customerId}/overview`),
  });

  if (isLoading) return <Spinner label="Loading customer" />;
  if (!data) return null;

  const { customer, conversations, tickets, activities } = data;
  const ai = customer.aiContext;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Avatar name={customer.displayName} size={40} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{customer.displayName ?? 'Unknown customer'}</p>
          <p className="truncate text-xs text-text-muted">{customer.company ?? customer.contactMethods[0]?.value ?? '—'}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {customer.tier ? <Badge tone="accent">{customer.tier}</Badge> : null}
        <Badge tone="muted">{customer.locale}</Badge>
        {customer.tags.map((tag) => (
          <Badge key={tag} tone="muted">
            {tag}
          </Badge>
        ))}
      </div>

      {/* AI context is what turns a profile into a briefing. */}
      {ai?.summary ? (
        <section className="rounded-md border border-accent/25 bg-accent/5 p-3">
          <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-accent">
            <span aria-hidden="true">✦</span> AI context
          </h3>
          <p className="text-xs leading-relaxed text-text">{ai.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ai.intent ? <Badge tone="info">{ai.intent}</Badge> : null}
            {ai.sentiment ? (
              <Badge tone={ai.sentiment === 'negative' ? 'danger' : ai.sentiment === 'positive' ? 'success' : 'muted'}>
                {ai.sentiment}
              </Badge>
            ) : null}
            {ai.riskLevel ? (
              <Badge tone={ai.riskLevel === 'high' ? 'danger' : ai.riskLevel === 'medium' ? 'warning' : 'muted'}>
                risk: {ai.riskLevel}
              </Badge>
            ) : null}
          </div>
          {ai.currentIssue ? <p className="mt-2 text-xs text-text-muted">Current issue: {ai.currentIssue}</p> : null}
        </section>
      ) : null}

      <Section title="Contact">
        <ul className="space-y-1">
          {customer.contactMethods.map((method) => (
            <li key={method.value} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-text-muted">{method.kind}</span>
              <span className="truncate font-medium">{method.value}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Conversations (${conversations.length})`}>
        <ul className="space-y-1.5">
          {conversations.slice(0, 5).map((conversation) => (
            <li key={conversation.id} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{conversation.subject ?? conversation.reference}</span>
                <Badge tone={statusTone[conversation.status]}>{conversation.status}</Badge>
              </div>
              <span className="text-text-muted">{relativeTime(conversation.createdAt)}</span>
            </li>
          ))}
          {!conversations.length ? <li className="text-xs text-text-muted">No previous conversations</li> : null}
        </ul>
      </Section>

      <Section title={`Tickets (${tickets.length})`}>
        <ul className="space-y-1.5">
          {tickets.slice(0, 5).map((ticket) => (
            <li key={ticket.id} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{ticket.subject}</span>
                <Badge tone={statusTone[ticket.status]}>{ticket.status}</Badge>
              </div>
              <span className="text-text-muted">
                {ticket.reference} · {relativeTime(ticket.createdAt)}
              </span>
            </li>
          ))}
          {!tickets.length ? <li className="text-xs text-text-muted">No tickets</li> : null}
        </ul>
      </Section>

      <Section title="Activity">
        <ol className="space-y-1.5">
          {activities.slice(0, 10).map((activity) => (
            <li key={activity.id} className="text-xs">
              <span className="font-medium">{activity.title}</span>
              <span className="ms-1 text-text-muted">{relativeTime(activity.occurredAt)}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}
