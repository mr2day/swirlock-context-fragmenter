# Reality Drift Detection and Experience Memory

Design document for the next layer of Context Fragmenter consolidation:
**after-the-fact hallucination auditing** and the **experience-lesson
memory** that follows from it.

This is a forward-looking design. None of it is implemented yet. The
purpose of this doc is to lock the shape of the feature so the
implementation pass can stay disciplined.

## Motivating example

The user once asked the bot about Romanian organized crime — Fane
Spoitoru, Nicu Gheară, their alleged rivalry. The bot produced a
long, confident, internally-consistent narrative with specific dates,
named bodyguards, locations, claimed quoted interviews. Most of it
was hallucinated. The conversation finished without anyone noticing.

A human in that situation would not just forget. They would
internalise something like:

> *"I once talked about Romanian crime lords — Fane Spoitoru and
> Nicu Gheară. I hallucinated most of my answer. That was bad. Next
> time I should search more and hallucinate less."*

That sentence is a **durable life-experience fact about the
assistant** — exactly the kind of memory the v1 Chatbot Manifest
described under "app identity memory" and "sleep". The Context
Fragmenter is the right place to build it.

## What "reality drift" means here

We are not trying to determine objective truth. We are looking for a
**substantiation gap**: a turn in which the assistant produced
specific, real-world factual claims that nothing in the conversation
or retrieved evidence backs up.

Three orthogonal axes:

| Axis | What it means | Why it matters |
| --- | --- | --- |
| **Specificity** | Named entities, dates, numbers, quoted claims | High-risk vocabulary; vague language can't really hallucinate |
| **Grounding** | Was SEARCH used for this turn? Were sources cited? | Grounded turns are out of scope — that's a retrieval-quality problem, not a hallucination problem |
| **Verifiability** | Can the claim be checked against an external source at all? | Opinions, jokes, personal-state statements ("I'm a robot") are not in scope |

A turn is **audit-eligible** when specificity is high, grounding is
low, and verifiability is non-zero.

## The gate: which turns to audit

We never audit every turn. The gate has two layers — a free
structural pre-filter and a cheap LLM-driven decision for whatever
the pre-filter lets through.

### Why not a regex/keyword-only gate

A purely deterministic gate would have to encode hedge words,
relationship verbs, self-citation phrases, and proper-noun heuristics
that all change per language. A regex pack tuned for English and
Romanian would degrade for Italian, Spanish, French, German;
deteriorate further for Finnish, Hungarian, Estonian, Basque, Turkish
(agglutinative morphology defeats fixed lexical patterns); and fall
apart for Arabic, Greek, Hebrew, Georgian, Armenian, Korean, Japanese,
Thai (different scripts, no casing-based proper-noun detection, no
useful surface markers for the lexical features above). The bot is
not single-language and the gate cannot be either.

The fragmenter LLM is already multilingual. We use that, scoped
narrowly, as the gate.

### Layer 1 — structural pre-filter (no LLM, language-agnostic)

A turn is candidate for auditing only if all of the following hold.
All three are pure character / structural checks that work for any
language and any script:

1. **No SEARCH on this turn.** If the orchestrator ran retrieval and
   the assistant's answer was grounded in attached evidence, the
   problem is "retrieval quality", not "hallucination". Different
   feature, different fix.
2. **Length above threshold.** Answers shorter than ~600–800 chars
   rarely contain enough specific claims to be worth a check.
3. **Specifics-density above threshold.** Cheap structural counters,
   normalized per 1k chars:
   - **Year-like numeric tokens** (`19\d\d`, `20\d\d`, plus the
     equivalent over Arabic-Indic digits `[٠-٩]{4}`).
   - **Quantity-like tokens** (digits adjacent to short alpha runs of
     1–6 characters — the shape `(\d+)\s?([A-Za-z]{1,6})` and the
     same over the Unicode `\p{L}` letter class for non-Latin
     scripts).
   - **Quoted-substring count** across the common quote families
     (`"…"`, `'…'`, `« … »`, `„ … "`, `‹ … ›`, `「 … 」`, etc.)
     **without** any URL in the same paragraph.

   The unit names themselves do not matter — we never read them. We
   only count the *shape* `digit + short word`. That shape exists in
   every language we plan to support.

This pre-filter is intended to drop the trivial 80–90% of turns
(small talk, short factual replies, answers that already used SEARCH)
without spending an LLM call.

### Layer 2 — LLM gate (one Utility-LLM call, multilingual)

For turns that pass Layer 1, the fragmenter makes a single small
Utility-LLM call. The Utility LLM is the same multilingual model
already used for the session summary and identity extraction; it
needs no per-language tuning.

The prompt is roughly:

> You are reviewing a single message the assistant produced in a chat.
> Output STRICT JSON only:
> `{ "audit_worthy": boolean, "hallucination_risk": 0..10, "why": string }`.
> Mark `audit_worthy: true` only when the message makes specific
> factual claims about real-world people, places, organisations,
> events, dates, statistics, quoted statements, or relationships
> between named entities, AND those claims are not visibly grounded in
> sources cited inside this same message. Conversational pleasantries,
> opinions, self-descriptions, generic explanations, and clearly
> hypothetical statements are not audit-worthy. If the assistant
> itself signals uncertainty about any claim — phrases of the shape
> "I'm not sure", "I might be wrong", "I think", or any equivalent
> in any language — set `audit_worthy: true` regardless of the other
> criteria. Answer in any language; the underlying message can be in
> any language.

The model is told to be conservative — false positives just waste
search budget on Layer 3, while false negatives let bad memories form
silently — so we lean toward "yes, audit" on borderline cases.

Layer-2 cost: one Utility-LLM call per Layer-1-eligible turn, on
`maintenance` priority. The fragmenter runs while the user is
composing their next message, never blocking the live turn.

## Spot-check pipeline

When a turn passes the gate, the fragmenter runs the audit as a
background job (priority `maintenance`, same scheduling class as
sleep). The job:

1. **Extracts anchor claims.** A small Utility LLM call asks for the
   3–5 highest-risk *check-worthy* claims from the assistant message,
   shaped as
   `{ claim: string, anchor_terms: string[], stake: "low"|"medium"|"high" }`.
   "Anchor terms" are the search-ready substrings for that claim.
2. **Spot-checks each anchor.** Sends a `search.run` request to the
   RAG Engine over a persistent WebSocket at `/v5/retrieval`. This
   is a new peer relationship for the Fragmenter (its first non-LLM
   peer) and a new additive message type on the RAG Engine — the
   Fragmenter never opens its own Exa client. The RAG Engine
   returns cleaned highlights without its usual full-pipeline
   evidence-packaging steps. `extractLimit` per anchor: 1–2.
3. **Adjudicates each claim.** One Utility LLM call per claim with
   `{claim, retrieved evidence}` → verdict:
   - `verified` — evidence clearly supports the claim
   - `contradicted` — evidence clearly disagrees
   - `partial` — some elements supported, some not
   - `unverifiable` — no relevant evidence found (model honest mode)
4. **Rolls up to a turn-level verdict.**
   - Any `contradicted` → turn verdict `hallucinated`
   - ≥ 2 `unverifiable` + 0 `verified` → turn verdict `suspect`
   - Otherwise → `clean` (audit complete, no lesson formed)

The cost is bounded: ~3 search calls + ~4 LLM calls per audited turn.
Hard-capped per session per day to prevent budget runaway.

`unverifiable` is intentionally distinct from `contradicted`. We do
not want to write a memory that says "I hallucinated X" when the
truth is just "I couldn't find a source for X". The two have very
different lessons.

### Appeal pass (automated second opinion)

A separate sleep-time pass re-checks every audit whose verdict was
`hallucinated` or `suspect`, exactly once. `clean` verdicts are
never appealed. The appeal is the Fragmenter's automated stand-in
for a human-dispute mechanism — instead of asking the user "was this
audit correct?", we ask a fresh LLM pass with deliberately different
framing to argue against the original verdict.

To make the appeal a genuine second opinion (not a rubber stamp),
two things vary from the original audit:

- **Adversarial query rephrasing.** The LLM generates fresh search
  queries oriented toward *contradicting or invalidating* the
  original claim — negations, broadened entity context, alternative
  spellings, related-but-different framings. Queries that just
  rephrase the original supportive ones are rejected.
- **Adversarial adjudication framing.** Where the original
  adjudication prompt asked "does this evidence support the
  claim?", the appeal asks "what is the strongest case that this
  claim is wrong, mistaken, or unsupported by reliable sources? If
  such a case exists, output it; otherwise concede the original
  verdict stands."

Bounded depth: exactly one appeal per audit, ever. No
appeals-of-appeals. If the appeal contradicts the original, the
audit row's `disputed` flag is set and the audit is excluded from
all downstream lesson reinforcement. If the appeal confirms, the
audit stands and feeds `experience.distillation` normally.

Cost: one extra search round + one extra adjudication LLM call per
appealed audit. Since `clean` audits are not appealed and should be
the majority, the appeal pass roughly doubles the cost of
action-worthy audits but leaves the overall system cost modestly
higher, not 2×.

## Storage model

Two tables, both fragmenter-owned (per the v5 table-ownership rule),
both prefixed `fragmenter_`.

### `fragmenter_answer_audits`

One row per audited turn. Forensic detail — what the bot claimed,
what we found, what verdict we reached.

| column | type | notes |
| --- | --- | --- |
| id | TEXT PK (uuid) | |
| session_id | TEXT | matches orchestrator's `sessions.id` |
| turn_id | TEXT | matches orchestrator's `messages.turn_id` |
| assistant_message_id | TEXT | the specific message audited |
| user_id | TEXT | who was being answered |
| persona_name | TEXT | which persona generated the answer |
| occurred_at | TEXT (ISO) | when the original answer streamed |
| audited_at | TEXT (ISO) | when the audit ran |
| markers_triggered | JSON | which gate signals fired (Layer 1 counts + Layer 2 `why`) for debugging |
| claims_checked | JSON | array of `{claim, anchor_terms, retrieved_evidence_url, verdict, evidence_excerpt}` |
| turn_verdict | TEXT | `hallucinated` / `suspect` / `clean` |
| corrected_summary | TEXT | short prose: "I claimed X. Reality says Y." Nullable when verdict = clean. |
| appealed_at | TEXT (ISO) | when the appeal pass ran (NULL until appealed; `clean` audits stay NULL forever) |
| disputed | BOOLEAN | TRUE if the appeal pass contradicted the original verdict; excluded from lesson reinforcement |
| fragmenter_correlation_id | TEXT | for tracing |

Audits are append-only. They are not consumed at prompt time
directly — they are raw material for the experience-lesson pass.

### `fragmenter_experience_lessons`

Distilled, pattern-level lessons the assistant has learned from
clusters of audits. These ARE consumed at prompt time, as part of
the persona's identity.

| column | type | notes |
| --- | --- | --- |
| id | TEXT PK (uuid) | |
| persona_name | TEXT | scoped per persona, always — no per-user variant in the MVP (decision recorded; see History below) |
| content | TEXT | the lesson sentence, third-person about the assistant |
| importance | TEXT | `core` / `important` / `incidental` |
| source_audit_ids | JSON | array of audit ids the lesson was derived from |
| generated_at | TEXT (ISO) | |
| last_confirmed_at | TEXT (ISO) | bumped each time a fresh audit reinforces it |
| superseded_at, superseded_by_id | TEXT | sleep-merge supersedence, same pattern as identities |
| fragmenter_correlation_id | TEXT | |

Examples of well-shaped lesson content:

- `"When asked about post-1990s Romanian organised-crime figures, my unsourced claims are unreliable; I should SEARCH instead of recalling."` (core)
- `"My recall of band-member lineups and album release years is inconsistent without SEARCH."` (important)
- `"I tend to invent quoted interviews. I should not quote anyone unless a source is attached on this turn."` (core)

The content shape is deliberately **behavioural**, not just topical:
the lesson should tell the bot what to do differently next time, not
just what it got wrong this time.

## Pipeline placement

The audit runs in the existing consolidation pipeline as a new kind,
between `session.summary` and identity extraction:

```
session.observed
  → session.summary           (existing)
  → answer.reality_check      (new, only if last assistant message passes the Layer-1 + Layer-2 gate)
  → identity.user / identity.app   (existing)
sleep tick (every N min)
  → identity merges                (existing)
  → answer.audit_appeal            (new, re-checks `hallucinated`/`suspect` audits not yet appealed)
  → experience.distillation        (new, runs after appeals so disputed audits are excluded)
```

The `experience.distillation` pass groups recent `hallucinated` and
`suspect` audits (excluding ones flipped to `disputed` by the appeal
pass) for a persona, asks the Utility LLM to abstract them into
behavioural lessons, and writes or reinforces
`fragmenter_experience_lessons` rows.

Reinforcement and decay are **driven by repeatability, not by
calendar time** (decision Q4):

- For each new audit cluster, the distillation step similarity-matches
  against every existing active lesson for the same persona — one
  Utility-LLM call shaped roughly "does this audit reinforce any of
  the following existing lessons? If yes, which ones?". A reinforced
  lesson gets `last_confirmed_at` bumped and, after N reinforcements,
  may be promoted one importance tier.
- For each existing active lesson with **no matching new audit for K
  consecutive sleep ticks**, importance is demoted one tier. A lesson
  already at `incidental` that fails to be reinforced for K more
  ticks is retired by setting `superseded_at`.

Time alone never decays a lesson. Only the *absence of fresh
reinforcing audits* does. A lesson the assistant keeps proving by
making the same kind of mistake stays core; a one-off that never
recurs eventually retires itself.

## Prompt-time consumption

The orchestrator's existing `FragmenterReaderService` grows one more
read: active experience lessons for the persona. Those lessons are
rendered into the **app-identity block** the orchestrator already
emits, with a `[lesson]` label so the persona can tell them apart
from positive self-facts. Example block:

```
What you know about yourself (durable facts):
- [core] I am a friendly robot named Gigi.
- [important] My users mostly speak Romanian.
- [lesson, core] When asked about post-1990s Romanian organised-crime
  figures, my unsourced claims are unreliable; I should SEARCH.
```

The orchestrator's classifier sees this same context one round
earlier — which means a lesson can directly shift the SEARCH/DIRECT
decision in the right direction next time. That closes the loop:

> bad answer → audit → lesson → classifier reads lesson → better
> retrieval decision → next answer is grounded.

## Cost guardrails

- **Layer-1 pre-filter** is free (counts and regex shape-matching,
  no LLM). Drops the bulk of turns.
- **Layer-2 LLM gate**: 1 small Utility-LLM call per Layer-1-eligible
  turn, capped to ~256 input tokens of context (the assistant message
  itself, possibly truncated). No retrieval at this stage.
- **Per-audit cap (Layer 3 onward)**: ≤ 5 claims, ≤ 3 search calls,
  ≤ 4 LLM calls, hard timeout 60 s.
- **Per-session quota**: ≤ 5 audits per session per calendar day,
  configurable.
- **Per-persona quota**: ≤ 50 audits per persona per day across all
  sessions.
- **Distillation cadence**: once per sleep tick, not per audit.

The audit must always run on `maintenance` priority on its own LLM
host queue. It must never block the user-facing turn.

## Decision history

The five design questions raised in the first draft have all been
resolved. Recorded here so future readers can see the reasoning
without diff-archaeology.

1. **Search provider** → the RAG Engine grows a new additive
   `search.run` message type on its existing `/v5/retrieval`
   WebSocket. The Fragmenter opens a persistent WebSocket to that
   endpoint (its first non-LLM peer) and never bundles its own Exa
   client. Cleanest separation of concerns: Exa stays owned by the
   RAG Engine; the Fragmenter consumes a thin contracted capability.

2. **Per-user vs per-persona lessons** → per-persona, always. When a
   persona talks to multiple users, the resulting lesson set is the
   union of failure modes across all users — which makes the
   persona more cautious overall, the direction we want. Per-user
   lessons can be revisited when we observe a real case of
   diverging conversation profiles requiring it.

3. **Self-flagged uncertainty as auto-audit trigger** → yes,
   handled inside the Layer-2 LLM gate prompt. We do not regex-match
   uncertainty phrases per language; we tell the multilingual gate
   model to recognise self-flagged uncertainty as a sufficient
   condition for `audit_worthy: true` regardless of other criteria.

4. **Lesson durability vs decay** → decay is driven by *repeatability,
   not by calendar time*. The distillation pass similarity-matches
   each new audit against existing active lessons; matches reinforce
   (bump `last_confirmed_at`, eventually promote importance);
   absence of matches for K consecutive sleep ticks demotes; an
   `incidental` lesson that fails to reinforce for another K ticks
   retires. Old lessons that the assistant keeps proving stay core;
   one-offs that never recur eventually disappear.

5. **Verdict appeal** → automated, not user-driven. The original
   open question asked how a human user would dispute a bad audit.
   The answer is they don't. The Fragmenter runs an **automated
   appeal pass** at sleep time over `hallucinated`/`suspect` audits
   exactly once, with deliberately adversarial query rephrasing and
   adversarial adjudication framing so the second opinion is
   genuine. Audits the appeal contradicts get `disputed = true` and
   are excluded from lesson reinforcement going forward. UX surface
   for human dispute can be added reactively if a stuck wrong
   lesson is ever observed in practice.

## Open implementation choices

Things genuinely undecided at design time, to be settled during
implementation by measuring:

- **Layer-1 thresholds.** Character-length floor for "long enough
  to bother auditing" (~600–800 chars is a starting guess) and
  specifics-density floors (year tokens / 1k chars, quote-mark
  count / paragraph). Tune on real traffic.
- **Reinforcement cadence (N) and decay cadence (K).** How many
  reinforcing audits before promoting a lesson one importance
  tier, and how many barren sleep ticks before demoting. Starting
  values: N = 3, K = 14 (about a week at 30-minute sleep cadence).
- **`search.run` message shape on the RAG Engine.** Whether to add
  a new top-level message type or to expose the thinner-pipeline
  behaviour via a flag on the existing `retrieve_evidence`. New
  message type is cleaner; flag is less work. Decide at
  implementation review.
- **Appeal-pass query-difference check.** How to confirm an
  adversarial-rephrased query is actually different from the
  original supportive query, not just a lexical reshuffle. Probably
  the LLM that generated it can self-confirm, but worth
  spot-checking on real cases.

## Relation to the v1 vision

This work fills two of the v1 manifest's named slots that don't yet
have implementations:

- **"App identity memory"** — durable facts about the persona itself.
  Experience lessons are exactly that.
- **"Sleep"** — the v1 manifest describes sleep as a process that
  "reevaluates memory importance, promotes or demotes memories,
  merges overlapping memories, compresses redundant memories,
  redistributes memory fragments across importance levels, refines
  user identity memory, refines app identity memory". Adding
  hallucination audits → lessons is a strict subset of that.

Building this layer does not require any contract changes. The v5
context-fragmenter contract already names `consolidationKind` as a
fragmenter-owned identifier; `answer.reality_check` and
`experience.lesson` slot in alongside `session.summary` cleanly.
