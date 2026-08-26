'use client';

import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { compactNumber, duration, money } from '@/lib/format';
import { Badge, Card, Empty, Spinner, Stat } from '@/components/ui';
import type { ExecutiveAnalytics } from '@/lib/types';

export default function AnalyticsPage() {
  const { data: executive, isLoading } = useQuery({
    queryKey: ['analytics', 'executive'],
    queryFn: () => get<ExecutiveAnalytics>('/analytics/executive'),
  });
  const { data: ai } = useQuery({
    queryKey: ['analytics', 'ai'],
    queryFn: () => get<AiAnalytics>('/analytics/ai'),
  });
  const { data: channels } = useQuery({
    queryKey: ['analytics', 'channels'],
    queryFn: () => get<ChannelRow[]>('/analytics/channels'),
  });
  const { data: agents } = useQuery({
    queryKey: ['analytics', 'agents'],
    queryFn: () => get<AgentRow[]>('/analytics/agents').catch(() => []),
  });
  const { data: series } = useQuery({
    queryKey: ['analytics', 'series'],
    queryFn: () =>
      get<{ series: { date: string; value: number }[] }>('/analytics/series/conversations'),
  });

  if (isLoading) return <Spinner label="Loading analytics" />;
  if (!executive) return null;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">Analytics</h1>
        <p className="mt-0.5 text-sm text-text-muted">
          Last 30 days across every channel, agent and AI execution.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Interactions"
          value={compactNumber(executive.interactions)}
          sub={`${executive.openNow} open now`}
        />
        <Stat
          label="Resolution rate"
          value={`${executive.resolutionRate}%`}
          sub={`${executive.resolved} resolved`}
        />
        <Stat
          label="AI resolution"
          value={`${executive.aiResolutionRate}%`}
          sub={`${executive.aiHandled} handled by AI`}
        />
        <Stat
          label="CSAT"
          value={executive.csat.average ? executive.csat.average.toFixed(2) : '—'}
          sub={`${executive.csat.responses} responses`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Conversations per day">
          <Sparkline series={series?.series ?? []} />
        </Card>

        <Card title="SLA attainment">
          <div className="space-y-2 p-4">
            {executive.sla.length ? (
              executive.sla.map((target) => (
                <div key={target.type}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="capitalize">{target.type.replace('_', ' ')}</span>
                    <span className="tabular-nums text-text-muted">
                      {target.attainmentPercent}% · {target.met} met, {target.breached} breached
                    </span>
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                    role="img"
                    aria-label={`${target.attainmentPercent}% attainment`}
                  >
                    <div
                      className={`h-full rounded-full ${target.attainmentPercent >= 95 ? 'bg-success' : target.attainmentPercent >= 85 ? 'bg-warning' : 'bg-danger'}`}
                      style={{ width: `${Math.max(2, target.attainmentPercent)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <Empty title="No completed SLA clocks yet" />
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="AI performance">
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
            <Metric label="Executions" value={compactNumber(ai?.executions.total ?? 0)} />
            <Metric label="Success" value={`${ai?.executions.successRate ?? 0}%`} />
            <Metric label="Handoff" value={`${ai?.handoffRate ?? 0}%`} />
            <Metric label="Spend" value={money(executive.aiCostUsd)} />
          </div>

          {ai?.models.length ? (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-xs">
                <thead className="text-text-muted">
                  <tr className="border-b border-border">
                    <th className="px-4 py-1.5 text-start font-medium">Model</th>
                    <th className="px-4 py-1.5 text-end font-medium">Calls</th>
                    <th className="px-4 py-1.5 text-end font-medium">Tokens</th>
                    <th className="px-4 py-1.5 text-end font-medium">Latency</th>
                    <th className="px-4 py-1.5 text-end font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {ai.models.map((model) => (
                    <tr key={model.model} className="border-b border-border last:border-0">
                      <td className="px-4 py-1.5">{model.model}</td>
                      <td className="px-4 py-1.5 text-end tabular-nums">{model.calls}</td>
                      <td className="px-4 py-1.5 text-end tabular-nums">
                        {compactNumber(model.promptTokens + model.completionTokens)}
                      </td>
                      <td className="px-4 py-1.5 text-end tabular-nums">
                        {duration(model.averageLatencyMs)}
                      </td>
                      <td className="px-4 py-1.5 text-end tabular-nums">{money(model.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {ai?.guardrails.length ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2.5">
              {ai.guardrails.map((entry) => (
                <Badge
                  key={`${entry.check}-${entry.action}`}
                  tone={entry.action === 'block' ? 'danger' : 'warning'}
                >
                  {entry.check.replace(/_/g, ' ')} · {entry.count}
                </Badge>
              ))}
            </div>
          ) : null}
        </Card>

        <Card title="Channels">
          {channels?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted">
                  <tr className="border-b border-border">
                    <th className="px-4 py-1.5 text-start font-medium">Channel</th>
                    <th className="px-4 py-1.5 text-end font-medium">Volume</th>
                    <th className="px-4 py-1.5 text-end font-medium">Resolved</th>
                    <th className="px-4 py-1.5 text-end font-medium">First response</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((channel) => (
                    <tr key={channel.channel} className="border-b border-border last:border-0">
                      <td className="px-4 py-1.5 capitalize">
                        {channel.channel.replace('_', ' ')}
                      </td>
                      <td className="px-4 py-1.5 text-end tabular-nums">{channel.volume}</td>
                      <td className="px-4 py-1.5 text-end tabular-nums">
                        {channel.resolutionRate}%
                      </td>
                      <td className="px-4 py-1.5 text-end tabular-nums">
                        {duration(channel.averageFirstResponseMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No channel activity yet" />
          )}
        </Card>
      </div>

      {agents?.length ? (
        <Card title="Agent performance">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-1.5 text-start font-medium">Agent</th>
                  <th className="px-4 py-1.5 text-end font-medium">Handled</th>
                  <th className="px-4 py-1.5 text-end font-medium">Resolved</th>
                  <th className="px-4 py-1.5 text-end font-medium">AHT</th>
                  <th className="px-4 py-1.5 text-end font-medium">FCR</th>
                  <th className="px-4 py-1.5 text-end font-medium">CSAT</th>
                  <th className="px-4 py-1.5 text-end font-medium">QA</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.userId} className="border-b border-border last:border-0">
                    <td className="px-4 py-1.5">{agent.name}</td>
                    <td className="px-4 py-1.5 text-end tabular-nums">{agent.handled}</td>
                    <td className="px-4 py-1.5 text-end tabular-nums">{agent.resolutionRate}%</td>
                    <td className="px-4 py-1.5 text-end tabular-nums">
                      {duration(agent.averageHandleTimeMs)}
                    </td>
                    <td className="px-4 py-1.5 text-end tabular-nums">
                      {agent.firstContactResolutionRate}%
                    </td>
                    <td className="px-4 py-1.5 text-end tabular-nums">
                      {agent.csat?.toFixed(2) ?? '—'}
                    </td>
                    <td className="px-4 py-1.5 text-end tabular-nums">
                      {agent.qaScore?.toFixed(1) ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** A minimal inline chart — no library, and it inherits the theme tokens. */
function Sparkline({ series }: { series: { date: string; value: number }[] }) {
  if (!series.length) return <Empty title="No data in this period" />;

  const max = Math.max(...series.map((point) => point.value), 1);
  const width = 100;
  const height = 32;
  const step = series.length > 1 ? width / (series.length - 1) : width;
  const path = series
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'} ${(index * step).toFixed(2)} ${(height - (point.value / max) * height).toFixed(2)}`,
    )
    .join(' ');

  const total = series.reduce((sum, point) => sum + point.value, 0);

  return (
    <div className="p-4">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label={`${total} conversations over ${series.length} days, peaking at ${max} in a day`}
      >
        <path d={`${path} L ${width} ${height} L 0 ${height} Z`} fill="rgb(var(--accent) / 0.12)" />
        <path
          d={path}
          fill="none"
          stroke="rgb(var(--accent))"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex justify-between text-xs text-text-muted">
        <span>{series[0]?.date}</span>
        <span className="font-medium text-text">
          {total} total · peak {max}
        </span>
        <span>{series.at(-1)?.date}</span>
      </div>
    </div>
  );
}

interface AiAnalytics {
  executions: { total: number; successRate: number };
  handoffRate: number;
  models: {
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    averageLatencyMs: number;
  }[];
  guardrails: { check: string; action: string; count: number }[];
}

interface ChannelRow {
  channel: string;
  volume: number;
  resolutionRate: number;
  averageFirstResponseMs: number;
}

interface AgentRow {
  userId: string;
  name: string;
  handled: number;
  resolutionRate: number;
  averageHandleTimeMs: number;
  firstContactResolutionRate: number;
  csat: number | null;
  qaScore: number | null;
}
