# UX flows & design system

## Primary surfaces

| Surface | Audience | Route |
|---|---|---|
| Agent Workspace | Agents, supervisors | `/workspace` |
| Admin Console | Administrators | `/admin` |
| AI Studio | AI builders | `/ai` |
| Analytics | Analysts, supervisors | `/analytics` |
| Chat Widget | Customers | embeddable `widget.js` |

## Agent workspace layout

```
┌──────────────────────────────────────────┐
│ Queue / Inbox                            │
├────────────────────┬─────────────────────┤
│ Conversation       │ Customer 360        │
│ Messages           │ Profile · Timeline  │
│                    │ Tickets · AI Context│
├────────────────────┴─────────────────────┤
│ AI Copilot                               │
└──────────────────────────────────────────┘
```

Three columns on desktop (≥1280px); the Customer 360 rail collapses to a drawer between
1024–1280px; below that the workspace becomes a single-column stack with a bottom tab
bar. The copilot is a dockable bottom panel, collapsible to a single suggestion strip.

## Key journeys

**Customer self-serve → AI → human**
1. Customer opens widget, is identified (token or anonymous session).
2. `conversation.created` → routing evaluates → AI agent assigned.
3. Agent runtime answers with citations; sentiment and intent stream to the workspace.
4. Confidence drops below threshold or the customer asks for a person →
   `handoff.requested` → conversation is queued for humans with an AI-written summary.
5. Human agent accepts; the full AI transcript, retrieved citations and reasoning are
   visible in the conversation.

**Agent resolving with copilot**
1. Agent opens a queued conversation; Customer 360 loads with AI context.
2. Copilot proposes a response grounded in knowledge, with sources.
3. Agent edits tone/translates, sends, adds an internal note.
4. Agent resolves; a ticket is created or updated; SLA clocks stop.
5. AI-QC scores the interaction asynchronously.

**Builder shipping an agent**
1. Create agent → set instructions, model role, knowledge scope, tools, guardrails.
2. Compose the workflow on the canvas; test in the debugger with a sample input.
3. Run the evaluation suite; review accuracy, groundedness, cost and latency.
4. Publish version → promote through `development → staging → production`.

## Design system

**Tokens** — colour, spacing (4px base), radius, elevation, typography and motion are
CSS custom properties defined once and themed per organization branding.

| Token group | Values |
|---|---|
| Spacing | `2, 4, 8, 12, 16, 24, 32, 48, 64` |
| Radius | `sm 6px`, `md 10px`, `lg 14px`, `full` |
| Type scale | `12, 13, 14, 16, 20, 24, 32` / line-height 1.45 |
| Motion | `fast 120ms`, `base 200ms`, `slow 320ms`, ease-out |

**Semantic colour** — `surface`, `surface-raised`, `border`, `text`, `text-muted`,
`accent`, `success`, `warning`, `danger`, `info`. Every pair meets WCAG AA (4.5:1 for
body text, 3:1 for large text and UI boundaries), in both light and dark themes.

**Status colour mapping** — new `info`, queued `info`, assigned `accent`, active
`accent`, waiting `warning`, resolved `success`, closed `text-muted`; SLA at-risk
`warning`, breached `danger`.

**Accessibility** — full keyboard operation, visible focus rings, ARIA live regions for
incoming messages, respects `prefers-reduced-motion`, no colour-only status encoding
(always paired with an icon or label).

**Localization** — all copy externalized; RTL layout support (Arabic is a first-class
locale, as routing rules assume); locale-aware dates, numbers and business hours.
