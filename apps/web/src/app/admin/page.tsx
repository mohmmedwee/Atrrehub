'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Spinner, inputClass } from '@/components/ui';

type Tab = 'people' | 'queues' | 'knowledge' | 'automation' | 'quality';

const TABS: { key: Tab; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'queues', label: 'Queues & teams' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'automation', label: 'Automation' },
  { key: 'quality', label: 'Quality' },
];

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('people');

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">Administration</h1>
        <p className="mt-0.5 text-sm text-text-muted">
          Configure your organization, its people and its operating rules.
        </p>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Admin sections">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            onClick={() => setTab(entry.key)}
            aria-current={tab === entry.key ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-fast ${
              tab === entry.key
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'people' ? <People /> : null}
      {tab === 'queues' ? <Queues /> : null}
      {tab === 'knowledge' ? <Knowledge /> : null}
      {tab === 'automation' ? <Automation /> : null}
      {tab === 'quality' ? <Quality /> : null}
    </div>
  );
}

function People() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', roleKey: 'agent' });

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => get<{ data: UserRow[] }>('/users', { limit: 100 }),
  });
  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => get<RoleRow[]>('/roles'),
  });

  const invite = useMutation({
    mutationFn: () => post('/users', form),
    onSuccess: () => {
      setForm({ email: '', firstName: '', lastName: '', roleKey: 'agent' });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card title="Members">
        {isLoading ? <Spinner /> : null}
        <ul className="divide-y divide-border">
          {data?.data.map((user) => (
            <li key={user.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {user.firstName} {user.lastName}
                </p>
                <p className="truncate text-xs text-text-muted">{user.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {user.skills?.length ? <Badge tone="muted">{user.skills.join(', ')}</Badge> : null}
                <Badge tone={user.status === 'active' ? 'success' : 'warning'}>{user.status}</Badge>
                <Badge tone="accent">{user.role.key}</Badge>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Invite someone">
        <div className="space-y-3 p-4">
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="First name">
              <input
                className={inputClass}
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </Field>
            <Field label="Last name">
              <input
                className={inputClass}
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Role" hint="You cannot grant permissions you do not hold yourself.">
            <select
              className={inputClass}
              value={form.roleKey}
              onChange={(e) => setForm({ ...form, roleKey: e.target.value })}
            >
              {roles?.map((role) => (
                <option key={role.id} value={role.key}>
                  {role.name} ({role.permissions.length} permissions)
                </option>
              ))}
            </select>
          </Field>
          <Button
            onClick={() => invite.mutate()}
            disabled={!form.email || !form.firstName || invite.isPending}
            full
          >
            {invite.isPending ? 'Sending…' : 'Send invitation'}
          </Button>
          {invite.isError ? (
            <p className="text-xs text-danger">Could not send the invitation.</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function Queues() {
  const { data: queues } = useQuery({
    queryKey: ['queues'],
    queryFn: () => get<QueueRow[]>('/queues'),
  });
  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: () => get<TeamRow[]>('/teams'),
  });
  const { data: hours } = useQuery({
    queryKey: ['business-hours'],
    queryFn: () => get<HoursRow[]>('/business-hours'),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Queues">
        <ul className="divide-y divide-border">
          {queues?.map((queue) => (
            <li key={queue.id} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{queue.name}</span>
                <div className="flex items-center gap-1.5">
                  {queue.aiFirst ? <Badge tone="accent">AI first</Badge> : null}
                  <Badge tone="muted">{queue.strategy.replace(/_/g, ' ')}</Badge>
                </div>
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {queue._count?.conversations ?? 0} conversations
                {queue.team ? ` · ${queue.team.name}` : ''}
                {queue.slaPolicy ? ` · ${queue.slaPolicy.name}` : ''}
              </p>
            </li>
          ))}
          {!queues?.length ? <Empty title="No queues configured" /> : null}
        </ul>
      </Card>

      <div className="space-y-4">
        <Card title="Teams">
          <ul className="divide-y divide-border">
            {teams?.map((team) => (
              <li key={team.id} className="px-4 py-2.5">
                <p className="text-sm font-medium">{team.name}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {team.members?.length ?? 0} members
                  {team.skills?.length ? ` · ${team.skills.join(', ')}` : ''}
                  {team.languages?.length ? ` · ${team.languages.join(', ')}` : ''}
                </p>
              </li>
            ))}
            {!teams?.length ? <Empty title="No teams yet" /> : null}
          </ul>
        </Card>

        <Card title="Business hours">
          <ul className="divide-y divide-border">
            {hours?.map((calendar) => (
              <li key={calendar.id} className="px-4 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{calendar.name}</span>
                  {calendar.isDefault ? <Badge tone="accent">default</Badge> : null}
                </div>
                <p className="mt-0.5 text-xs text-text-muted">
                  {calendar.timezone} · {calendar.rules.length} working day
                  {calendar.rules.length === 1 ? '' : 's'} · {calendar.holidays?.length ?? 0}{' '}
                  holidays
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Knowledge() {
  const queryClient = useQueryClient();
  const [article, setArticle] = useState({ knowledgeBaseId: '', title: '', body: '' });

  const { data: bases } = useQuery({
    queryKey: ['kb'],
    queryFn: () => get<BaseRow[]>('/knowledge/bases'),
  });
  const { data: articles } = useQuery({
    queryKey: ['articles'],
    queryFn: () => get<{ data: ArticleRow[] }>('/knowledge/articles', { limit: 50 }),
  });

  const create = useMutation({
    mutationFn: async () => {
      const created = await post<{ id: string }>('/knowledge/articles', article);
      await post(`/knowledge/articles/${created.id}/publish`);
    },
    onSuccess: () => {
      setArticle({ knowledgeBaseId: article.knowledgeBaseId, title: '', body: '' });
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card title="Articles">
        <ul className="divide-y divide-border">
          {articles?.data.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{entry.title}</p>
                <p className="text-xs text-text-muted">
                  v{entry.version} · {relativeTime(entry.updatedAt)}
                </p>
              </div>
              <Badge tone={entry.state === 'published' ? 'success' : 'muted'}>{entry.state}</Badge>
            </li>
          ))}
          {!articles?.data.length ? (
            <Empty title="No articles yet" hint="Published articles ground every AI answer." />
          ) : null}
        </ul>
      </Card>

      <Card title="Publish an article">
        <div className="space-y-3 p-4">
          <Field label="Knowledge base">
            <select
              className={inputClass}
              value={article.knowledgeBaseId}
              onChange={(e) => setArticle({ ...article, knowledgeBaseId: e.target.value })}
            >
              <option value="">Select…</option>
              {bases?.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              className={inputClass}
              value={article.title}
              onChange={(e) => setArticle({ ...article, title: e.target.value })}
            />
          </Field>
          <Field label="Body" hint="Published immediately and indexed for retrieval.">
            <textarea
              className={`${inputClass} resize-y`}
              rows={6}
              value={article.body}
              onChange={(e) => setArticle({ ...article, body: e.target.value })}
            />
          </Field>
          <Button
            onClick={() => create.mutate()}
            disabled={
              !article.knowledgeBaseId ||
              !article.title ||
              article.body.length < 10 ||
              create.isPending
            }
            full
          >
            {create.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Automation() {
  const { data: rules } = useQuery({
    queryKey: ['automation'],
    queryFn: () => get<RuleRow[]>('/automation/rules'),
  });
  const { data: runs } = useQuery({
    queryKey: ['automation-runs'],
    queryFn: () => get<RunRow[]>('/automation/runs'),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Rules">
        <ul className="divide-y divide-border">
          {rules?.map((rule) => (
            <li key={rule.id} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{rule.name}</span>
                <Badge tone={rule.isActive ? 'success' : 'muted'}>
                  {rule.isActive ? 'active' : 'paused'}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                on {rule.trigger.replace(/_/g, ' ')} →{' '}
                {rule.actions.map((action) => action.type).join(', ')}
              </p>
              <p className="mt-0.5 text-xs text-text-muted">{rule.runCount} runs</p>
            </li>
          ))}
          {!rules?.length ? (
            <Empty title="No automation rules" hint="Rules act on triggers without involving AI." />
          ) : null}
        </ul>
      </Card>

      <Card title="Recent runs">
        <ul className="divide-y divide-border">
          {runs?.slice(0, 15).map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-2 px-4 py-2">
              <span className="truncate text-xs text-text-muted">
                {run.subjectType} · {relativeTime(run.createdAt)}
              </span>
              <div className="flex gap-1">
                {run.actionsRun.map((action, index) => (
                  <Badge key={index} tone={action.ok ? 'success' : 'danger'}>
                    {action.type}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
          {!runs?.length ? <Empty title="No runs yet" /> : null}
        </ul>
      </Card>
    </div>
  );
}

function Quality() {
  const { data: templates } = useQuery({
    queryKey: ['qc-templates'],
    queryFn: () => get<TemplateRow[]>('/quality/templates'),
  });
  const { data: evaluations } = useQuery({
    queryKey: ['qc-evaluations'],
    queryFn: () => get<EvaluationRow[]>('/quality/evaluations'),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Scorecards">
        <ul className="divide-y divide-border">
          {templates?.map((template) => (
            <li key={template.id} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{template.name}</span>
                <Badge tone="muted">pass ≥ {template.passingScore}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {template.criteria.map((criterion) => (
                  <Badge key={criterion.id} tone={criterion.isCritical ? 'danger' : 'muted'}>
                    {criterion.name} {criterion.weight}%
                  </Badge>
                ))}
              </div>
            </li>
          ))}
          {!templates?.length ? <Empty title="No scorecards yet" /> : null}
        </ul>
      </Card>

      <Card title="Recent evaluations">
        <ul className="divide-y divide-border">
          {evaluations?.slice(0, 15).map((evaluation) => (
            <li key={evaluation.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <span className="text-xs text-text-muted">
                {evaluation.template?.name} · {relativeTime(evaluation.createdAt)}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tabular-nums">
                  {evaluation.score.toFixed(1)}
                </span>
                <Badge tone={evaluation.passed ? 'success' : 'danger'}>
                  {evaluation.passed ? 'pass' : 'fail'}
                </Badge>
              </div>
            </li>
          ))}
          {!evaluations?.length ? (
            <Empty
              title="No evaluations yet"
              hint="Conversations are scored automatically once resolved."
            />
          ) : null}
        </ul>
      </Card>
    </div>
  );
}

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  skills?: string[];
  role: { key: string };
}
interface RoleRow {
  id: string;
  key: string;
  name: string;
  permissions: string[];
}
interface QueueRow {
  id: string;
  name: string;
  strategy: string;
  aiFirst: boolean;
  team: { name: string } | null;
  slaPolicy: { name: string } | null;
  _count?: { conversations: number };
}
interface TeamRow {
  id: string;
  name: string;
  members?: unknown[];
  skills?: string[];
  languages?: string[];
}
interface HoursRow {
  id: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  rules: unknown[];
  holidays?: unknown[];
}
interface BaseRow {
  id: string;
  name: string;
}
interface ArticleRow {
  id: string;
  title: string;
  state: string;
  version: number;
  updatedAt: string;
}
interface RuleRow {
  id: string;
  name: string;
  trigger: string;
  isActive: boolean;
  runCount: number;
  actions: { type: string }[];
}
interface RunRow {
  id: string;
  subjectType: string;
  createdAt: string;
  actionsRun: { type: string; ok: boolean }[];
}
interface TemplateRow {
  id: string;
  name: string;
  passingScore: number;
  criteria: { id: string; name: string; weight: number; isCritical: boolean }[];
}
interface EvaluationRow {
  id: string;
  score: number;
  passed: boolean;
  createdAt: string;
  template?: { name: string };
}
