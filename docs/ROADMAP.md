# Context Fragmenter — Roadmap

Operational single-source view: where we are, what's left, what to ship next.
Everything theoretical lives in the documents linked below. This file is
explicitly *not* the place for rationale, philosophy, or alternatives
considered.

## Final goal

Implement the Context Fragmenter as described in
[v1 CHATBOT_MANIFEST.md](../../swirlock-chatbot-contracts/docs/versions/v1/CHATBOT_MANIFEST.md).
In short:

- memory organised by **type and importance**, not as flat history
- explicit **short-term** vs **long-term** separation
- a durable **user identity memory** and **app (persona) identity memory**
- **per-query relevance selection** — fragments recombined at prompt time
- scheduled reorganisation (**"sleep"**) that reinforces, decays, merges, retires
- **self-reflection**: auditing of suspect answers and accumulation of
  behavioural lessons ([REALITY_DRIFT.md](./REALITY_DRIFT.md))

The Context Fragmenter is the agentic-AI primitive for *inward-looking*
memory; the RAG Engine is the *outward-looking* counterpart.

## Current state

| Capability | Status | Notes |
| --- | --- | --- |
| Session summary | done | rolling per-session text in `fragmenter_session_summaries`; auto-extracted after N new messages |
| User identity facts | done | per-row, importance-tiered, supersedence-aware in `fragmenter_user_identities` |
| App (persona) identity facts | done | same shape, keyed by `persona_name`, in `fragmenter_app_identities` |
| Sleep job (identity merge) | done | every 30 min; dedups and re-tiers active facts |
| Startup backfill | done | walks every session on boot, enqueues those past the debounce threshold |
| Orchestrator → fragmenter notifications | done | `session.observed` / `session.invalidate` over persistent WS, fire-and-forget |
| Fragmenter → orchestrator notifications | done | optional `consolidation.updated` |
| Orchestrator reads fragmenter tables | done | `FragmenterReaderService`, plain SQL on shared SQLite |
| Fragmented-context block in prompt | partial | injected as a system message; no per-query relevance selection yet — everything active gets dumped |
| Repeatability-driven decay | planned | applies to both identity and (future) lessons |
| Reality-drift gate (Layer 1 + 2) | planned | [REALITY_DRIFT.md](./REALITY_DRIFT.md) |
| Reality-drift spot-check + audits | planned | [REALITY_DRIFT.md](./REALITY_DRIFT.md) |
| Appeal pass | planned | [REALITY_DRIFT.md](./REALITY_DRIFT.md) |
| Experience-lesson distillation | planned | [REALITY_DRIFT.md](./REALITY_DRIFT.md) |
| Experience lessons in app-identity prompt block | planned | depends on distillation |
| `search.run` capability on RAG Engine | planned | new additive v5 message type on `/v5/retrieval` |
| Short-term vs long-term explicit tiering | not started | partially implicit today (summary vs identity) |
| Per-query relevance selection | not started | last major v1 piece |

## Action plan

Ordered. Each unit ships independently. Sequence or pause as needed.

### Unit A — `search.run` on RAG Engine

Adds a thinner message type on `/v5/retrieval` that takes a search
query and returns cleaned highlights, skipping the
evidence-packaging the chat orchestrator gets from
`retrieve_evidence`.

- **Touches:** RAG Engine code, v5 contract doc (`apps/rag-engine.md`).
- **Depends on:** nothing.
- **Unblocks:** Units D, E.

### Unit B — Repeatability-driven decay for identity facts

Tracks reinforcement on identity rows (matching new extractions
during sleep). Demotes the tier on rows not reinforced for K
consecutive sleep ticks; retires `incidental` rows after K more.

- **Touches:** `IdentityService`, `SleepService`, small schema
  additions (`last_confirmed_at`, `barren_ticks`) on the identity
  tables.
- **Depends on:** nothing — uses existing data.
- **Note:** Reuses the same mechanism Unit F (experience-lessons
  distillation) will need. Implementing here first lets us tune the
  cadences on real data before they ride lessons too.

### Unit C — Reality-drift gate (Layer 1 + Layer 2)

Structural pre-filter + Utility-LLM `audit_worthy` call after every
assistant turn. **Log decisions only**, no audit storage yet. The
purpose at this stage is to observe gate quality on real traffic
before any downstream consumer depends on it.

- **Touches:** new `RealityDriftGateService` in the fragmenter.
- **Depends on:** nothing.
- **Unblocks:** Unit D.

### Unit D — Reality-drift spot-check + audit storage

For turns the gate marks audit-worthy, call `search.run`, adjudicate
claim-by-claim, write `fragmenter_answer_audits` rows with verdict
and (when applicable) corrected summary.

- **Touches:** new `RealityDriftAuditService`, new
  `fragmenter_answer_audits` table, new `consolidationKind:
  answer.reality_check`.
- **Depends on:** Unit A (`search.run`), Unit C (gate).

### Unit E — Appeal pass

Sleep-time second-opinion over `hallucinated` / `suspect` audits
with adversarial query rephrasing and adversarial adjudication.
Flips `disputed = true` on audits the appeal contradicts.

- **Touches:** `SleepService`, audit table (`appealed_at`,
  `disputed`).
- **Depends on:** Unit D.

### Unit F — Experience-lesson distillation + decay

Cluster non-disputed `hallucinated`/`suspect` audits → behavioural
lessons in `fragmenter_experience_lessons`. Reuses the repeatability
decay mechanism from Unit B (now generalised). Implements Q4 of
[REALITY_DRIFT.md](./REALITY_DRIFT.md).

- **Touches:** new `ExperienceLessonService` + new table.
- **Depends on:** Unit D, Unit E, Unit B (mechanism).

### Unit G — Lessons in the orchestrator prompt

`FragmenterReaderService` reads experience lessons; they appear in
the app-identity block as `[lesson, tier]` entries. This is what
closes the loop — the orchestrator's classifier sees its own
lessons and starts choosing SEARCH on patterns it learned to fear.

- **Touches:** orchestrator (`FragmenterReaderService`,
  `buildAnswerPrompt`).
- **Depends on:** Unit F (table populated).

### Unit H — Per-query relevance selection (the v1 "fragmented" semantics)

Replace the current "dump all active facts" rendering with
relevance-selected fragments. Likely an embedding match between the
current user query and per-fact embeddings, with a rule that always
includes `core` tier regardless of relevance score.

- **Touches:** orchestrator, possibly the embedding service (per-fact
  embeddings stored on the identity / lessons tables).
- **Depends on:** nothing structurally; can be slotted any time after
  identity tables have meaningful content.

## What's deliberately not on the list

- Cross-user lessons — resolved per-persona only.
- UX for human dispute of audits — resolved; automated appeal pass handles it.
- Formal "short-term" vs "long-term" split as separate tables — the
  current shape (summary = short-term, identity = long-term) is enough
  until a concrete use case demands sharper tiering.
- Memory graphs / entity-relation extraction — not in v1 vision.

## How this doc stays useful

- One change per merge: when a unit ships, flip its status in the table.
- New design decisions go to [REALITY_DRIFT.md](./REALITY_DRIFT.md) (or a
  new design doc) — not here. This file stays operational.
- If a unit needs to grow into multiple units, split it in place; don't
  smuggle scope into an existing unit.
