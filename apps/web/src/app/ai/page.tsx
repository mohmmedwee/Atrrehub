'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { duration, money, relativeTime, statusTone } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Spinner, inputClass } from '@/components/ui';
import type { Agent, ExecutionDebug } from '@/lib/types';

/** AI Studio: agents, a test console and the execution debugger. */
export default function AiStudioPage() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<string | null>(null);

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => get<Agent[]>('/agents'),
  });
  const { data: executions } = useQuery({
    queryKey: ['executions', selectedAgent],
    queryFn: () =>
      get<
        {
          id: string;
          status: string;
          triggerType: string;
          durationMs: number | null;
          promptTokens: number;
          completionTokens: number;
          costUsd: string;
          createdAt: string;
          error: string | null;
        }[]
      >('/agents/executions', selectedAgent ? { agentId: selectedAgent } : undefined),
    refetchInterval: 10_000,
  });

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI Studio</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Build, test and observe the AI agents handling your conversations.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-4">
          <Card title="Agents">
            {isLoading ? <Spinner /> : null}
            {!isLoading && !agents?.length ? (
              <Empty
                title="No agents yet"
                hint="Create an agent to start deflecting conversations with AI."
              />
            ) : null}
            <ul className="divide-y divide-border">
              {agents?.map((agent) => (
                <li key={agent.id}>
                  <button
                    onClick={() => setSelectedAgent(agent.id === selectedAgent ? null : agent.id)}
                    aria-pressed={selectedAgent === agent.id}
                    className={`w-full px-4 py-3 text-start transition-colors duration-fast hover:bg-surface-sunken ${
                      selectedAgent === agent.id ? 'bg-accent/5' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{agent.name}</span>
                      <Badge tone={agent.state === 'published' ? 'success' : 'muted'}>
                        {agent.state}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-text-muted">
                      {agent.description ?? agent.key}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {agent.versions.length} version{agent.versions.length === 1 ? '' : 's'}
                      {agent.versions[0]?.publishedAt
                        ? ` · live v${agent.versions[0].version}`
                        : ' · draft'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {selectedAgent ? (
            <TestConsole agentId={selectedAgent} onExecution={setSelectedExecution} />
          ) : null}
        </div>

        <div className="space-y-4">
          <Card title="Recent executions">
            {!executions?.length ? (
              <Empty title="No executions yet" hint="Run an agent to see its trace here." />
            ) : null}
            <ul className="divide-y divide-border">
              {executions?.slice(0, 12).map((execution) => (
                <li key={execution.id}>
                  <button
                    onClick={() => setSelectedExecution(execution.id)}
                    className={`w-full px-4 py-2.5 text-start transition-colors duration-fast hover:bg-surface-sunken ${
                      selectedExecution === execution.id ? 'bg-accent/5' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs">
                        <Badge tone={statusTone[execution.status]}>{execution.status}</Badge>
                        <span className="text-text-muted">{execution.triggerType}</span>
                      </span>
                      <span className="text-xs tabular-nums text-text-muted">
                        {duration(execution.durationMs)} ·{' '}
                        {execution.promptTokens + execution.completionTokens} tok ·{' '}
                        {money(Number(execution.costUsd))}
                      </span>
                    </div>
                    {execution.error ? (
                      <p className="mt-1 truncate text-xs text-danger">{execution.error}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-text-muted">
                      {relativeTime(execution.createdAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {selectedExecution ? <ExecutionDebugger executionId={selectedExecution} /> : null}
        </div>
      </div>
    </div>
  );
}

function TestConsole({
  agentId,
  onExecution,
}: {
  agentId: string;
  onExecution: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');

  const run = useMutation({
    mutationFn: () =>
      post<{ executionId: string; status: string; costUsd: number }>(`/agents/${agentId}/run`, {
        message,
      }),
    onSuccess: (result) => {
      onExecution(result.executionId);
      // Without this the run appears in the debugger but not in the list beside
      // it until the ten-second poll comes round, which reads as the run having
      // been lost.
      void queryClient.invalidateQueries({ queryKey: ['executions'] });
    },
  });

  return (
    <Card title="Test console">
      <div className="space-y-3 p-4">
        <Field label="Customer message" hint="Runs the published version and records a full trace.">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            className={`${inputClass} resize-y`}
            placeholder="How long do refunds take?"
          />
        </Field>
        <Button
          onClick={() => message.trim() && run.mutate()}
          disabled={!message.trim() || run.isPending}
        >
          {run.isPending ? 'Running…' : 'Run agent'}
        </Button>
        {run.isError ? (
          <p className="text-xs text-danger">
            The run failed. Check the agent has a published version.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The execution debugger — every step with its input, output, model, tokens
 * and cost, plus the tool calls and guardrail decisions that shaped it.
 */
function ExecutionDebugger({ executionId }: { executionId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['execution', executionId],
    queryFn: () => get<ExecutionDebug>(`/agents/executions/${executionId}`),
  });

  if (isLoading) return <Spinner label="Loading trace" />;
  if (!data) return null;

  return (
    <Card title="Execution trace">
      <div className="border-b border-border px-4 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={statusTone[data.execution.status]}>{data.execution.status}</Badge>
          <span className="text-text-muted">{duration(data.execution.durationMs)}</span>
          <span className="text-text-muted">
            {data.execution.promptTokens + data.execution.completionTokens} tokens
          </span>
          <span className="text-text-muted">{money(data.execution.costUsd)}</span>
        </div>
        {data.execution.error ? <p className="mt-1.5 text-danger">{data.execution.error}</p> : null}
      </div>

      <ol className="divide-y divide-border">
        {data.steps.map((step) => (
          <li key={step.sequence} className="px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-xs">
                <span className="tabular-nums text-text-muted">{step.sequence}.</span>
                <span className="font-medium">{step.nodeName ?? step.nodeId}</span>
                <Badge tone="muted">{step.nodeType}</Badge>
                <Badge tone={statusTone[step.status]}>{step.status}</Badge>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-text-muted">
                {duration(step.durationMs)}
                {step.model ? ` · ${step.model}` : ''}
                {step.promptTokens + step.completionTokens > 0
                  ? ` · ${step.promptTokens + step.completionTokens} tok`
                  : ''}
              </span>
            </div>

            {step.error ? <p className="mt-1 text-xs text-danger">{step.error}</p> : null}

            {step.output !== null && step.output !== undefined ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
                  Output
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-surface-sunken p-2 text-xs">
                  {JSON.stringify(step.output, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ol>

      {data.guardrails.length ? (
        <div className="border-t border-border px-4 py-2.5">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Guardrail decisions
          </h3>
          <ul className="space-y-1">
            {data.guardrails.map((event) => (
              <li key={event.id} className="flex items-center gap-2 text-xs">
                <Badge
                  tone={
                    event.action === 'block'
                      ? 'danger'
                      : event.action === 'handoff'
                        ? 'warning'
                        : 'muted'
                  }
                >
                  {event.action}
                </Badge>
                <span>{event.check.replace(/_/g, ' ')}</span>
                <span className="text-text-muted">({event.stage})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.toolCalls.length ? (
        <div className="border-t border-border px-4 py-2.5">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Tool calls
          </h3>
          <ul className="space-y-1">
            {data.toolCalls.map((call) => (
              <li key={call.id} className="flex items-center gap-2 text-xs">
                <Badge tone={call.status === 'succeeded' ? 'success' : 'danger'}>
                  {call.status}
                </Badge>
                <span className="text-text-muted">{duration(call.durationMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
