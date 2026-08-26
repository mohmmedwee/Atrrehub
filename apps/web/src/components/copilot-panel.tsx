'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { post } from '@/lib/api';
import { Badge, Button } from '@/components/ui';

interface Suggestion {
  action: string;
  suggestion?: string;
  citations?: { index: number; title: string }[];
  groundedness?: number;
  confidence?: number;
  warnings?: string[];
  recommendation?: { action: string; reason: string; urgency: string };
  summary?: string;
  keyPoints?: string[];
}

/**
 * The AI copilot. Suggestions are always shown with their sources and any
 * guardrail warnings, so the agent is deciding whether to send something they
 * can verify — never pasting an unattributed answer.
 */
export function CopilotPanel({
  conversationId,
  draft,
  onUse,
  onClose,
}: {
  conversationId: string;
  draft: string;
  onUse: (text: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Suggestion | null>(null);

  const assist = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      post<Suggestion>('/copilot/assist', { conversationId, ...body }),
    onSuccess: setResult,
  });

  const actions = [
    { label: 'Suggest reply', body: { action: 'suggest_reply' } },
    { label: 'Summarize', body: { action: 'summarize' } },
    { label: 'Next action', body: { action: 'next_best_action' } },
    { label: 'Rewrite', body: { action: 'rewrite', draft }, needsDraft: true },
    {
      label: 'Warmer tone',
      body: { action: 'adjust_tone', tone: 'empathetic', draft },
      needsDraft: true,
    },
    {
      label: 'Translate',
      body: { action: 'translate', targetLocale: 'Arabic', draft },
      needsDraft: true,
    },
  ];

  return (
    <section
      className="shrink-0 border-t border-border bg-surface-raised px-3 py-2.5"
      aria-label="AI copilot"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
          <span aria-hidden="true">✦</span> AI Copilot
        </h2>
        <button
          onClick={onClose}
          className="text-xs text-text-muted hover:text-text"
          aria-label="Hide copilot"
        >
          Hide
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <Button
            key={action.label}
            size="sm"
            variant="secondary"
            disabled={assist.isPending || (action.needsDraft && !draft.trim())}
            title={action.needsDraft && !draft.trim() ? 'Write a draft first' : undefined}
            onClick={() => assist.mutate(action.body)}
          >
            {action.label}
          </Button>
        ))}
      </div>

      {assist.isPending ? <p className="mt-2 text-xs text-text-muted">Thinking…</p> : null}
      {assist.isError ? (
        <p className="mt-2 text-xs text-danger">The copilot could not respond. Try again.</p>
      ) : null}

      {result ? (
        <div className="mt-2 rounded-md border border-border bg-surface p-2.5">
          {result.suggestion ? (
            <>
              <p className="whitespace-pre-wrap text-sm">{result.suggestion}</p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {result.citations?.map((citation) => (
                  <Badge key={citation.index} tone="info">
                    [{citation.index}] {citation.title}
                  </Badge>
                ))}
                {result.groundedness !== undefined ? (
                  <Badge
                    tone={
                      result.groundedness >= 0.7
                        ? 'success'
                        : result.groundedness >= 0.4
                          ? 'warning'
                          : 'danger'
                    }
                  >
                    grounded {Math.round(result.groundedness * 100)}%
                  </Badge>
                ) : null}
                {result.warnings?.map((warning) => (
                  <Badge key={warning} tone="warning">
                    {warning.replace('_', ' ')}
                  </Badge>
                ))}
              </div>

              <div className="mt-2">
                <Button size="sm" onClick={() => onUse(result.suggestion!)}>
                  Use this draft
                </Button>
              </div>
            </>
          ) : null}

          {result.recommendation ? (
            <div>
              <p className="text-sm font-medium">
                Recommended: {result.recommendation.action.replace(/_/g, ' ')}{' '}
                <Badge tone={result.recommendation.urgency === 'high' ? 'danger' : 'muted'}>
                  {result.recommendation.urgency}
                </Badge>
              </p>
              <p className="mt-1 text-xs text-text-muted">{result.recommendation.reason}</p>
            </div>
          ) : null}

          {result.summary ? (
            <div>
              <p className="text-sm">{result.summary}</p>
              {result.keyPoints?.length ? (
                <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-xs text-text-muted">
                  {result.keyPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
