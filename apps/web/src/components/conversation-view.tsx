'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { get, post } from '@/lib/api';
import { onRealtime, subscribeConversation } from '@/lib/realtime';
import { channelLabel, relativeTime, statusTone } from '@/lib/format';
import { Badge, Button, Spinner } from '@/components/ui';
import { CopilotPanel } from '@/components/copilot-panel';
import type { ConversationSummary, Message, Page } from '@/lib/types';

/** The conversation thread, composer and AI copilot. */
export function ConversationView({
  conversation,
  onBack,
}: {
  conversation: ConversationSummary;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [isNote, setIsNote] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['messages', conversation.id],
    queryFn: () => get<Page<Message>>(`/conversations/${conversation.id}/messages`, { limit: 100 }),
  });

  const { data: signals } = useQuery({
    queryKey: ['signals', conversation.id],
    queryFn: () =>
      get<
        { id: string; signal: string; severity: string; message: string; guidance: string | null }[]
      >(`/quality/signals/${conversation.id}`),
    // Live compliance guidance is only useful while the conversation is open.
    refetchInterval: 30_000,
  });

  // Join the conversation room so new messages arrive without polling.
  useEffect(() => {
    const leave = subscribeConversation(conversation.id);
    const off = onRealtime('message', (payload: { conversationId: string }) => {
      if (payload.conversationId === conversation.id) {
        queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] });
      }
    });
    return () => {
      leave();
      off();
    };
  }, [conversation.id, queryClient]);

  const messages = data?.data ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const send = useMutation({
    mutationFn: async (body: string) =>
      isNote
        ? post(`/conversations/${conversation.id}/notes`, { body })
        : post(`/conversations/${conversation.id}/messages`, { body }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => post(`/conversations/${conversation.id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onBack}
            className="text-text-muted hover:text-text lg:hidden"
            aria-label="Back to queue"
          >
            ←
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {conversation.subject ?? conversation.customer?.displayName ?? conversation.reference}
            </h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
              <span>{conversation.reference}</span>
              <span aria-hidden="true">·</span>
              <span>{channelLabel[conversation.channel] ?? conversation.channel}</span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={statusTone[conversation.status]}>{conversation.status}</Badge>
          {conversation.status !== 'resolved' && conversation.status !== 'closed' ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setStatus.mutate('resolved')}
              disabled={setStatus.isPending}
            >
              Resolve
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setStatus.mutate('active')}
              disabled={setStatus.isPending}
            >
              Reopen
            </Button>
          )}
        </div>
      </header>

      {/* Live quality guidance sits above the thread, where an agent will act on it. */}
      {signals?.length ? (
        <div className="shrink-0 space-y-1 border-b border-border bg-warning/5 px-4 py-2">
          {signals.slice(0, 2).map((signal) => (
            <p key={signal.id} className="text-xs text-warning">
              <span className="font-semibold uppercase">{signal.signal.replace('_', ' ')}</span> —{' '}
              {signal.message}
              {signal.guidance ? (
                <span className="text-text-muted"> · {signal.guidance}</span>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
        aria-relevant="additions"
      >
        {isLoading ? <Spinner label="Loading messages" /> : null}
        <ul className="space-y-3">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </ul>
        <div ref={endRef} />
      </div>

      {copilotOpen ? (
        <CopilotPanel
          conversationId={conversation.id}
          draft={draft}
          onUse={setDraft}
          onClose={() => setCopilotOpen(false)}
        />
      ) : null}

      <footer className="shrink-0 border-t border-border bg-surface p-3">
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => setIsNote(false)}
            aria-pressed={!isNote}
            className={`rounded-md px-2 py-1 text-xs font-medium ${!isNote ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface-sunken'}`}
          >
            Reply
          </button>
          <button
            onClick={() => setIsNote(true)}
            aria-pressed={isNote}
            className={`rounded-md px-2 py-1 text-xs font-medium ${isNote ? 'bg-warning/10 text-warning' : 'text-text-muted hover:bg-surface-sunken'}`}
          >
            Internal note
          </button>
          {!copilotOpen ? (
            <button
              onClick={() => setCopilotOpen(true)}
              className="ms-auto text-xs text-accent hover:underline"
            >
              Show copilot
            </button>
          ) : null}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline — the convention agents expect.
              if (event.key === 'Enter' && !event.shiftKey && draft.trim()) {
                event.preventDefault();
                send.mutate(draft.trim());
              }
            }}
            rows={2}
            placeholder={isNote ? 'Add a note only your team can see…' : 'Write a reply…'}
            aria-label={isNote ? 'Internal note' : 'Reply to customer'}
            className={`min-h-[52px] flex-1 resize-y rounded-md border px-3 py-2 text-sm focus:outline-none ${
              isNote
                ? 'border-warning/40 bg-warning/5'
                : 'border-border bg-surface focus:border-accent'
            }`}
          />
          <Button
            onClick={() => draft.trim() && send.mutate(draft.trim())}
            disabled={!draft.trim() || send.isPending}
          >
            {send.isPending ? 'Sending…' : isNote ? 'Add note' : 'Send'}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isCustomer = message.direction === 'inbound';
  const isNote = message.isPrivate || message.type === 'note';

  if (isNote) {
    return (
      <li className="mx-auto max-w-2xl rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
        <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-warning">
          Internal note
        </p>
        <p className="whitespace-pre-wrap text-sm text-text">{message.body}</p>
        <p className="mt-1 text-xs text-text-muted">{relativeTime(message.createdAt)}</p>
      </li>
    );
  }

  return (
    <li className={`flex ${isCustomer ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[min(42rem,80%)] rounded-lg border px-3 py-2 ${
          isCustomer ? 'border-border bg-surface' : 'border-accent/25 bg-accent/5'
        }`}
      >
        <div className="mb-1 flex items-center gap-2 text-xs text-text-muted">
          <span className="font-medium text-text">
            {message.authorName ??
              (isCustomer ? 'Customer' : message.authorType === 'ai_agent' ? 'AI agent' : 'Agent')}
          </span>
          {message.authorType === 'ai_agent' ? <Badge tone="accent">AI</Badge> : null}
          <span>{relativeTime(message.createdAt)}</span>
          {!isCustomer && message.deliveryState === 'failed' ? (
            <Badge tone="danger">not delivered</Badge>
          ) : null}
        </div>

        <p className="whitespace-pre-wrap text-sm">{message.body}</p>

        {/* Citations make an AI answer checkable rather than merely plausible. */}
        {message.citations?.length ? (
          <ul className="mt-2 space-y-0.5 border-t border-border pt-1.5">
            {message.citations.map((citation) => (
              <li key={citation.index} className="text-xs text-text-muted">
                <span className="font-medium text-accent">[{citation.index}]</span> {citation.title}
                {citation.heading ? ` — ${citation.heading}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}
