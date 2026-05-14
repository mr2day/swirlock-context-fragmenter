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

## Detection markers (the gate)

We never audit every turn. We score each finished assistant message
against a small set of cheap, deterministic markers; if the score
crosses a threshold the audit pipeline runs.

Suggested markers, all computed by the fragmenter without an LLM:

1. **Specific-entity density.** Count proper-noun tokens, year-like
   numbers (`19\d\d`, `20\d\d`), and money/quantity tokens
   (`\d+(\.\d+)?\s?(km|km/h|kg|million|miliard|lei|euros?|dollar)`).
   Normalize per 1k chars.
2. **Citation-free length.** Long answers (> 1500 chars) that did
   not consume any RAG evidence on this turn. Length without
   grounding correlates with confabulation.
3. **Cross-fact density.** Sentences that connect ≥ 2 named entities
   with a relationship verb (`a colaborat cu`, `a fost rival cu`,
   `was married to`, `worked with`). Cross-fact narratives are the
   most expensive to verify and the most often invented.
4. **High-risk domain heuristic.** Match against a curated keyword
   list per persona: biographical claims about non-public people,
   regional underworld histories, niche scientific/medical claims,
   recent/breaking events past the model's training cutoff. Tunable
   per deployment.
5. **Hedge-density paradox.** Many small hedges (`pare că`,
   `probabil`, `aparent`, `se spune că`) inside an otherwise
   confident-sounding answer. LLMs often soften individual claims
   while compounding many of them into a confident whole.
6. **Bot self-citation pattern.** The bot says "according to
   reports" / "sources say" / "presa a relatat că" without a single
   actual source being attached.

These are deliberately conservative — false positives just spend
search budget; false negatives let bad memory form. The threshold is
configured per persona.

Turns that already ran SEARCH on this turn are **excluded** from
auditing. Auditing them would re-litigate retrieval quality, which is
a different problem.

## Spot-check pipeline

When a turn passes the gate, the fragmenter runs the audit as a
background job (priority `maintenance`, same scheduling class as
sleep). The job:

1. **Extracts anchor claims.** A small Utility LLM call asks for the
   3–5 highest-risk *check-worthy* claims from the assistant message,
   shaped as
   `{ claim: string, anchor_terms: string[], stake: "low"|"medium"|"high" }`.
   "Anchor terms" are the search-ready substrings for that claim.
2. **Spot-checks each anchor.** Run an Exa search per anchor
   (`extractLimit: 1–2`). Use cleaned highlights as evidence.
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
| markers_triggered | JSON | which heuristics fired (debugging) |
| claims_checked | JSON | array of `{claim, anchor_terms, retrieved_evidence_url, verdict, evidence_excerpt}` |
| turn_verdict | TEXT | `hallucinated` / `suspect` / `clean` |
| corrected_summary | TEXT | short prose: "I claimed X. Reality says Y." Nullable when verdict = clean. |
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
| persona_name | TEXT | scoped per persona; `user_id` could be added if we want per-user lessons |
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
  → session.summary       (existing)
  → answer.reality_check  (new, only if last assistant message passes the gate)
  → identity.user / identity.app   (existing)
sleep tick (every N min)
  → identity merges       (existing)
  → experience.distillation (new, runs after identity merges)
```

The `experience.distillation` pass groups recent `hallucinated` and
`suspect` audits for a persona, asks the Utility LLM to abstract
them into behavioural lessons, and writes new
`fragmenter_experience_lessons` rows. Subsequent sleep ticks merge
near-duplicates the same way identity rows are merged.

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

- **Audit eligibility gate** is cheap (regex + counts). 0 LLM calls
  for ineligible turns.
- **Per-audit cap**: ≤ 5 claims, ≤ 3 search calls, ≤ 4 LLM calls,
  hard timeout 60 s.
- **Per-session quota**: ≤ 5 audits per session per calendar day,
  configurable.
- **Per-persona quota**: ≤ 50 audits per persona per day across all
  sessions.
- **Distillation cadence**: once per sleep tick, not per audit.

The audit must always run on `maintenance` priority on its own LLM
host queue. It must never block the user-facing turn.

## Open questions

1. **Search provider.** Today the RAG Engine owns the Exa
   integration. The Fragmenter does not currently talk to Exa.
   Options: (a) duplicate the Exa client in the fragmenter, (b) the
   RAG Engine grows a thin "search-only" capability the Fragmenter
   can call, (c) move the Exa client to a shared library both apps
   import. (c) is cleanest but a bigger refactor.
2. **Per-user vs per-persona lessons.** Right now we propose
   per-persona lessons only. Is "Gigi tends to hallucinate Romanian
   crime details when talking to *Nick*" interesting enough to be
   per-user? Probably not in the MVP. Revisit when we have multiple
   users with diverging conversation profiles.
3. **Self-flagged uncertainty as auto-audit trigger.** If the bot
   itself says "I'm not 100% sure" or "I might be wrong about this"
   mid-answer, should that automatically trigger an audit even when
   other markers don't fire? Probably yes — it's the cheapest, most
   reliable signal.
4. **Lesson durability vs decay.** A lesson with no recent
   reinforcing audits — does it stay forever? Sleep could decay
   importance over time so the persona doesn't stay haunted by a
   single old failure. Same `last_confirmed_at` field handles this
   if sleep treats it as decay input.
5. **Verdict appeal.** Sometimes the audit will be wrong (the search
   returned an irrelevant page, the LLM mis-classified). Should the
   user be able to flag an audit as wrong? The schema supports this
   trivially (a `disputed` flag column), but the UX is out of scope
   for the MVP.

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
