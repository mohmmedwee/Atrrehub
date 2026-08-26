'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { onRealtime } from '@/lib/realtime';
import { channelLabel, priorityTone, relativeTime, sentimentTone, statusTone } from '@/lib/format';
import { Avatar, Badge, Empty, ErrorNote, Spinner } from '@/components/ui';
import { ConversationView } from '@/components/conversation-view';
import { CustomerPanel } from '@/components/customer-panel';
import type { ConversationSummary, Page } from '@/lib/types';

type Filter = 'inbox' | 'unassigned' | 'all';

const FILTERS: { key: Filter; label: string; query: Record<string, string> }[] = [
  { key: 'inbox', label: 'My inbox', query: {} },
  { key: 'unassigned', label: 'Unassigned', query: { unassigned: 'true', status: 'new,queued' } },
  { key: 'all', label: 'All open', query: { status: 'new,queued,assigned,active,waiting' } },
];

/**
 * The agent workspace.
 *
 * Three columns on desktop: queue, conversation, customer 360. Below 1280px
 * the customer rail collapses; below 1024px the whole thing becomes a stack
 * where selecting a conversation replaces the list.
 */
export default function WorkspacePage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('inbox');
  const [selected, setSelected] = useState<string | null>(null);

  const path = filter === 'inbox' ? '/conversations/inbox' : '/conversations';
  const query = FILTERS.find((entry) => entry.key === filter)!.query;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['conversations', filter],
    queryFn: () => get<Page<ConversationSummary>>(path, { ...query, limit: 50, sort: '-lastMessageAt' }),
    refetchInterval: 20_000,
  });

  // New traffic should appear without the agent reaching for refresh.
  useEffect(() => {
    const off = [
      onRealtime('message', () => queryClient.invalidateQueries({ queryKey: ['conversations'] })),
      onRealtime('queue:updated', () => queryClient.invalidateQueries({ queryKey: ['conversations'] })),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [queryClient]);

  const conversations = data?.data ?? [];
  const active = conversations.find((conversation) => conversation.id === selected) ?? null;

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* Queue */}
      <aside
        className={`flex w-full shrink-0 flex-col border-e border-border bg-surface lg:w-80 ${
          selected ? 'hidden lg:flex' : 'flex'
        }`}
        aria-label="Conversation queue"
      >
        <div className="flex gap-1 border-b border-border p-2">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              onClick={() => setFilter(entry.key)}
              aria-pressed={filter === entry.key}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-fast ${
                filter === entry.key ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface-sunken'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? <Spinner /> : null}
          {isError ? <ErrorNote error={error} retry={refetch} /> : null}
          {!isLoading && !conversations.length ? (
            <Empty title="Nothing waiting" hint="New conversations appear here as they arrive." />
          ) : null}

          <ul>
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  onClick={() => setSelected(conversation.id)}
                  aria-current={selected === conversation.id ? 'true' : undefined}
                  className={`w-full border-b border-border px-3 py-2.5 text-start transition-colors duration-fast hover:bg-surface-sunken ${
                    selected === conversation.id ? 'bg-accent/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <Avatar name={conversation.customer?.displayName ?? 'Unknown'} url={conversation.customer?.avatarUrl} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {conversation.customer?.displayName ?? 'Unknown customer'}
                        </span>
                        <span className="shrink-0 text-xs text-text-muted">
                          {relativeTime(conversation.lastMessageAt ?? conversation.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-text-muted">
                        {conversation.subject ?? conversation.reference}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <Badge tone={statusTone[conversation.status]}>{conversation.status}</Badge>
                        <Badge tone="muted">{channelLabel[conversation.channel] ?? conversation.channel}</Badge>
                        {conversation.priority !== 'normal' ? (
                          <Badge tone={priorityTone[conversation.priority]}>{conversation.priority}</Badge>
                        ) : null}
                        {conversation.intelligence?.sentimentScore != null ? (
                          <Badge tone={sentimentTone(conversation.intelligence.sentimentScore)}>
                            {conversation.intelligence.sentiment}
                          </Badge>
                        ) : null}
                        {conversation.assigneeType === 'ai_agent' ? <Badge tone="accent">AI</Badge> : null}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Conversation */}
      <main className={`min-w-0 flex-1 ${selected ? 'flex' : 'hidden lg:flex'} flex-col bg-surface-sunken`}>
        {active ? (
          <ConversationView conversation={active} onBack={() => setSelected(null)} />
        ) : (
          <Empty title="Select a conversation" hint="Pick a conversation from the queue to see the full thread, the customer's history and AI assistance." />
        )}
      </main>

      {/* Customer 360 */}
      {active?.customer ? (
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-s border-border bg-surface xl:block" aria-label="Customer details">
          <CustomerPanel customerId={active.customer.id} />
        </aside>
      ) : null}
    </div>
  );
}
