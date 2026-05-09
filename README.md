# Swirlock Context Fragmenter

Background memory-consolidation peer module for the Swirlock chatbot
ecosystem. Implements
[Swirlock Chatbot Contracts v5](../swirlock-chatbot-contracts/docs/versions/v5/apps/context-fragmenter.md).

## Role In The Ecosystem

The fragmenter runs continuously alongside the
[Chat Orchestrator](../swirlock-chat-orchestrator/) and prepares
consolidated views of conversation history that the orchestrator will
read on later turns. The orchestrator **never blocks** on fragmenter
work and the fragmenter **never serves clients directly**.

Coordination is intentionally minimal:

- The orchestrator sends `session.observed` over a persistent WebSocket
  after every persisted turn. Fire-and-forget.
- The fragmenter decides when to consolidate (debounced; not on every
  observation).
- Consolidation results are written directly into the shared SQLite
  database; the orchestrator reads them with plain SQL at
  prompt-assembly time.
- An optional `consolidation.updated` event is pushed back so the
  orchestrator can invalidate any in-memory cache cheaply. The
  orchestrator is not required to act on it.

The fragmenter consumes exactly one **Fragmenter LLM Host** (1:1
module-to-LLM binding, per v5).

## Co-location Requirement

The fragmenter and orchestrator **must run on the same machine** because
they share a single SQLite file with table-level ownership:

- The orchestrator owns the live conversation tables
  (`sessions`, `messages`, `agent_events`, `agent_plans`,
  `agent_plan_steps`, `personas`, `persona_*`,
  `identity_mutation_candidates`). It is the only writer for those.
- The fragmenter owns its own working tables and result tables, all
  prefixed `fragmenter_*`. It is the only writer for those.
- Concurrent access uses SQLite WAL mode.

Other ecosystem apps (Model Host, RAG Engine, Embedding Service) may be
on different machines.

## WebSocket API

Endpoint:

```text
ws://127.0.0.1:3215/v5/fragmenter?token=dev-token-change-me
```

Inbound (orchestrator → fragmenter):

- `session.observed` — fire-and-forget; "session X had a new turn".
- `session.invalidate` — fire-and-forget; "I deleted session X".
- `health.get` — replied with `health`.
- `cancel` — cancels in-flight consolidation work for the given
  `correlationId`.
- `heartbeat` — replied with `heartbeat`.

Outbound (fragmenter → orchestrator):

- `consolidation.updated` — emitted after a result-table family is
  updated for a session.
- `health` — reply to `health.get`.
- `error` — standard error envelope.
- `heartbeat` — reply to `heartbeat`.

## MVP Scope

The first implementation supports exactly **one** consolidation kind:

- `session.summary` — a short rolling text summary of the whole
  conversation. Recomputed via a single Fragmenter LLM call when the
  session has accumulated enough new turns since the last summary.

Persona-level consolidation, transcript cleanup, and long-term-memory
extraction are reserved for later milestones.

## Configuration

Runtime configuration lives in one committed file:

- [`service.config.cjs`](./service.config.cjs)

Key slots:

- `host` / `port` — WebSocket listener (default `127.0.0.1:3215`).
- `bearerToken` — must match the orchestrator's
  `fragmenter.bearerToken`.
- `database.file` — absolute path to the shared SQLite file
  (typically the orchestrator's `data/chat-orchestrator.sqlite`).
- `llmHost.baseUrl` — Fragmenter LLM Host URL. The fragmenter opens
  exactly one persistent WebSocket to `${baseUrl}/v5/model`.
- `consolidation.sessionSummaryMinNewTurns` — debounce threshold.
- `consolidation.sessionSummaryMaxRecentMessages` — slice size of
  recent history fed into the summary prompt.

## Run

```powershell
npm install
npm run start:dev
```

PM2:

```powershell
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```
