'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  Database,
  Gauge,
  MessageSquare,
  Phone,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { tokens } from '@/lib/api';

/**
 * The public landing page.
 *
 * Built from the same tokens as the product rather than a separate marketing
 * stylesheet, so it themes with everything else and cannot drift from the
 * application it is describing.
 *
 * Deliberately does not bounce a signed-in visitor away: somebody who types
 * the root URL on purpose should be able to read the page. The call to action
 * changes instead.
 */

const CHANNELS = [
  'Web chat',
  'Email',
  'WhatsApp',
  'SMS',
  'Voice',
  'Telegram',
  'Messenger',
  'Instagram',
  'Teams',
];

const CAPABILITIES = [
  {
    icon: Bot,
    title: 'AI agents that hand off well',
    body: 'Agents answer from your knowledge base with citations. When confidence drops or the customer asks for a person, the conversation is queued for a human with the full transcript and an AI-written summary — not restarted from nothing.',
  },
  {
    icon: Workflow,
    title: 'A runtime, not a prompt box',
    body: 'Compose behaviour on a graph with tools, memory and branching. Test in a debugger against real input, run an evaluation suite, then promote a version through development, staging and production.',
  },
  {
    icon: ShieldCheck,
    title: 'Governance that actually enforces',
    body: 'Restrict providers, models and tools per organization and the gateway drops anything else from the routing chain. Token and cost ceilings, per-execution caps, retention windows, four-eyes publication — each checked where it binds.',
  },
  {
    icon: MessageSquare,
    title: 'Every channel, one inbox',
    body: 'Nine channels normalise to the same conversation model, so routing, SLA, quality scoring and reporting work identically whichever way the customer arrived.',
  },
  {
    icon: Phone,
    title: 'Voice with an AI that listens',
    body: 'IVR flows, recording with consent capture, and a voice agent with endpointing, barge-in and no-input recovery — handing off to a person mid-call with the transcript intact.',
  },
  {
    icon: Gauge,
    title: 'Workforce planning built in',
    body: 'Erlang C staffing from your own volumes, seasonal forecasting, rosters, time off and adherence — using a numerically stable recursion rather than a factorial that overflows past 170 agents.',
  },
];

const ENTERPRISE = [
  'Multi-tenant isolation enforced at three layers, verified in CI',
  'OIDC single sign-on and SCIM 2.0 provisioning',
  'Subject access export and a right to erasure that reaches every table',
  'Signed webhooks with replay, and a generated TypeScript SDK',
  'Automated backups verified by restoring into a scratch database',
  'Hybrid and air-gapped deployment with an enforced residency guard',
];

export default function LandingPage() {
  const [signedIn, setSignedIn] = useState(false);

  // Read after mount: the server has no localStorage, and branching on it
  // during render is a hydration mismatch on every load.
  useEffect(() => setSignedIn(Boolean(tokens.access())), []);

  const cta = signedIn
    ? { href: '/workspace', label: 'Open workspace' }
    : { href: '/login', label: 'Sign in' };

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <span
              aria-hidden="true"
              className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[13px] font-bold text-accent-fg"
            >
              A
            </span>
            Atrrehub
          </span>
          <nav className="flex items-center gap-5 text-[13px]">
            <a href="#capabilities" className="hidden text-text-muted hover:text-text sm:inline">
              Capabilities
            </a>
            <a href="#enterprise" className="hidden text-text-muted hover:text-text sm:inline">
              Enterprise
            </a>
            <Link
              href={cta.href}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg transition-opacity duration-fast hover:opacity-90"
            >
              {cta.label}
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="border-b border-border bg-surface-sunken">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:py-28">
            <p className="text-[13px] font-medium uppercase tracking-wide text-accent">
              AI-native contact center
            </p>
            <h1 className="mt-3 max-w-3xl text-[32px] font-semibold leading-[1.15] tracking-tight text-text sm:text-5xl sm:leading-[1.1]">
              Support that answers on its own — and knows when it shouldn&rsquo;t.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-text-muted sm:text-lg">
              Atrrehub puts an AI agent runtime at the centre of the contact center rather than
              bolted to the side of it. Nine channels, one conversation model, and a handoff to a
              person that carries everything the AI already learned.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={cta.href}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-opacity duration-fast hover:opacity-90"
              >
                {cta.label}
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link
                href="/widget-demo"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium text-text transition-colors duration-fast hover:bg-surface-sunken"
              >
                Try the chat widget
              </Link>
            </div>

            <div className="mt-12 flex flex-wrap gap-1.5">
              {CHANNELS.map((channel) => (
                <span
                  key={channel}
                  className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-text-muted"
                >
                  {channel}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section id="capabilities" className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="text-2xl font-semibold tracking-tight text-text">
            What it does differently
          </h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-text-muted">
            Most platforms add AI as a feature. This one is built around an agent runtime, which
            changes what the rest of the product has to look like.
          </p>

          <div className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <article key={title}>
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 place-items-center rounded-lg bg-accent/10 text-accent"
                >
                  <Icon size={17} />
                </span>
                <h3 className="mt-3.5 text-[15px] font-semibold text-text">{title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="enterprise" className="border-y border-border bg-surface-sunken">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-2 lg:gap-16">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-text">
                Built for the questions procurement asks
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-text-muted">
                Isolation, retention, erasure, provisioning and recovery are not a later phase.
                Foreign records return a 404 rather than a 403, because even the existence of
                another tenant&rsquo;s data is theirs.
              </p>
              <Link
                href={cta.href}
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
              >
                {cta.label}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>

            <ul className="space-y-3">
              {ENTERPRISE.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
                  <span className="text-[13px] leading-relaxed text-text">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-20">
          <div className="flex flex-col items-start gap-6 rounded-xl border border-border bg-surface-sunken p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div className="max-w-xl">
              <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-text">
                <Database size={18} aria-hidden="true" className="text-text-muted" />
                Run it wherever your data has to live
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
                Managed, in your own cloud, or fully air-gapped with a bundled local model and no
                outbound connection at all — the same application in each case.
              </p>
            </div>
            <Link
              href={cta.href}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-opacity duration-fast hover:opacity-90"
            >
              {cta.label}
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Atrrehub — AI-native omnichannel customer experience platform.</span>
          <Link href={cta.href} className="hover:text-text">
            {cta.label}
          </Link>
        </div>
      </footer>
    </div>
  );
}
