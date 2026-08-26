# AI architecture

## Model gateway

Applications never call a provider directly. They call the gateway with a **model role**,
and the gateway resolves the role to a concrete provider/model for that tenant.

| Role | Purpose | Typical default |
|---|---|---|
| `chat` | Customer-facing generation | frontier chat model |
| `fast` | Classification, extraction, routing | small/fast model |
| `reasoning` | Complex multi-step decisions, QC | reasoning-tier model |
| `embedding` | Vector indexing and retrieval | 1536-dim embedding model |
| `rerank` | Retrieval reranking | cross-encoder or LLM reranker |

Gateway responsibilities: provider adapters (OpenAI, Azure OpenAI, Anthropic, Gemini,
local/self-hosted, customer-supplied), model selection, fallback chains, streaming,
retry with jitter, per-tenant rate limiting, token accounting, cost accounting, latency
metrics and governance enforcement (allowed models, spend ceilings).

A **deterministic local provider** ships with the platform so the whole product runs,
and its tests pass, with no external API key. It produces structured, rule-derived
responses and hash-based embeddings — enough for development, CI and demos.

## RAG pipeline

```
Document → Parser → Cleaner → Chunker → Embedding → Vector index
                                                        ↓
Query → Embedding ─┬─► Vector search ─┐
                   └─► Keyword search ─┴─► RRF fusion → Rerank → Context → LLM → Answer + citations
```

- **Parser** — text, markdown, HTML, CSV, PDF and DOCX extraction with layout-aware
  paragraph recovery.
- **Cleaner** — boilerplate/navigation removal, whitespace normalization, dedup.
- **Chunker** — structure-aware: split on headings first, then sentences, target ~800
  tokens with ~120 token overlap; never split a code block or table row.
- **Embedding** — batched, content-hash cached; re-embedding only on content change.
- **Index** — `pgvector` HNSW for cosine similarity, plus a `tsvector` GIN index.
- **Fusion** — reciprocal rank fusion (`k=60`) over both result sets.
- **Rerank** — top 40 fused candidates reranked to top 6.
- **Citations** — every retrieved chunk carries document, section, version and URL, and
  is surfaced with the answer. Answers with no supporting citation are flagged
  ungrounded and, above the configured strictness, suppressed.
- **Access control** — the caller's readable knowledge-base set is applied as a SQL
  filter before ranking, so ACL can never be defeated by relevance.

## Agent runtime

An agent version binds: instructions, model role, temperature, knowledge scope, tool
set, memory policy, guardrail policy and handoff rules. Execution is a durable
interpreter over a workflow graph.

```
Trigger → Node → persist step → Node → ... → terminal
                     ↓
       suspend on human handoff / timer / external callback
```

Guarantees: every step transition is persisted before the next node executes;
executions resume after restart; node side effects are idempotency-keyed; a version is
immutable once published; cancellation is cooperative and checked between nodes.

### Node types

| Category | Nodes |
|---|---|
| Trigger | conversation started, message received, ticket created, webhook, schedule |
| AI | LLM, agent, intent, sentiment, classification |
| Knowledge | search, retrieve |
| Logic | condition, switch, router, loop, delay, set-variable |
| Action | send message, send email, create ticket, update ticket, update customer, HTTP request, webhook |
| Human | handoff, transfer, escalate |

### Execution debugger

Every execution records per node: input, output, duration, LLM calls (model, prompt and
completion tokens, cost, latency), tool calls (request, response, status), retries and
errors — so a builder can answer "why did the agent say that?" from the UI alone.

## Memory

| Scope | Contents | Lifetime |
|---|---|---|
| Short-term | Current conversation turns and working state | Conversation |
| Long-term | Customer preferences and durable history | Configurable retention, consent-gated |
| Agent | Workflow execution state and variables | Execution |

Controls: scope, retention window, permission to read/write, hard delete, consent flag
and PII protection. Long-term memory writes pass through PII detection; flagged spans
are masked or dropped per policy.

## Guardrails

Evaluated as an ordered pipeline; the first `block` decision wins and is audited.

| Stage | Check | Default action |
|---|---|---|
| input | prompt injection | block + human handoff |
| input | max length / rate | block |
| retrieval | ACL filter | filter |
| tool | authorization + egress allow-list | block |
| output | PII detection | mask |
| output | content policy | block |
| output | schema validation | retry once, then block |
| output | groundedness vs citations | flag or block by strictness |
| decision | confidence < threshold | human handoff |

## Evaluation

Datasets hold `input`, `expectedOutput`, and optionally `expectedContext` and
`expectedTools`. Metrics: accuracy, groundedness, relevance, safety, tool correctness,
retrieval quality (recall@k, MRR), latency and cost. An agent version must pass its
gate suite before it can be promoted to the `production` environment.

```
Agent v12 → Evaluation → Pass → Production
```

## Governance

Per organization: allowed models, allowed tools, per-agent permissions, token ceilings,
cost ceilings, knowledge access scope, human-approval requirements and data retention.
Every AI call records prompt version, model, input metadata, tools used, output,
cost, invoking user and agent version.
