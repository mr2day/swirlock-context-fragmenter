# Context Fragmenter — Philosophy

The story and the why. Operational details live in
[ROADMAP.md](./ROADMAP.md); design details for the self-reflection
layer live in [REALITY_DRIFT.md](./REALITY_DRIFT.md); the canonical
vision lives in
[v1 CHATBOT_MANIFEST.md](../../swirlock-chatbot-contracts/docs/versions/v1/CHATBOT_MANIFEST.md).
This document is the connective tissue — why the fragmenter exists,
what it's actually trying to be, and how the pieces fit together.

## What the Fragmenter is

It is the bot's memory.

Not "the database where messages get persisted" — that's the
orchestrator's job. The fragmenter is the *organized, reorganized,
self-aware* counterpart to flat transcript storage. Where the
orchestrator records what happened, the fragmenter decides what's
worth remembering, in what form, and how it should evolve over time.

A useful pairing: the **RAG Engine looks outward** — it queries the
web on demand for facts the bot doesn't carry. The **Context
Fragmenter looks inward** — it maintains a structured model of what
the bot has learned by living, both about the user and about itself.

## The "fragmented context" principle

The naming matters. The v1 manifest deliberately calls it the
*Context Fragmenter*, not the *Context Summarizer* or *Context
Manager*. The core idea: conversation context is not a single flat
stream of past turns. It is **fragmented by type, by importance,
and by ownership**.

- Some memory is durable (identity facts about the user); some is
  ephemeral (the rolling summary of the current session).
- Some memory is about the user (preferences, profession, language);
  some is about the assistant itself (lessons learned from past
  mistakes).
- Some memory is high-stakes and rides every prompt (`core` tier);
  some is low-stakes and only surfaces when relevant (`incidental`).
- Some memory ages well; some decays without reinforcement.

The fragmenter's whole job is to maintain this taxonomy and to
serve the right fragments at the right time. Naive "summarize the
last N turns" approaches collapse this taxonomy and lose the
structure that makes memory useful.

## The chapters of memory

Today's implementation has three of these. The others are planned
(see ROADMAP).

| Chapter | What it holds | Status |
| --- | --- | --- |
| Persona core | The bot's identity (name, character, base instructions) | always inline; owned by the orchestrator's session row |
| Life experience | Lessons the bot has learned about itself ("I tend to hallucinate when asked about X") | planned — REALITY_DRIFT.md |
| User identity | Durable facts about this user (name, language, location, profession, preferences) | done — `fragmenter_user_identities` |
| Cross-session conversation memory | Topical episodes from past sessions ("we once discussed Joe Satriani's discography in detail") | planned — ROADMAP Unit H |
| Current session summary | A rolling compressed view of the conversation up to the hot zone | done — `fragmenter_session_summaries` |
| Hot active zone | The last few thousand tokens of raw conversation, uncompressed | always inline; owned by the orchestrator |

The first and last chapters are always inline because they're small
and structurally critical. The middle chapters are where size grows
without bound — that's where the TOC + fetch architecture (below)
becomes necessary.

## Sleep

The v1 manifest calls the bot's periodic reorganization pass
*sleep*. The naming is intentional. Sleep is not a maintenance task
in the system-admin sense — it is the cognitive operation that
makes a human's memory not just bigger over time but *better*.

A useful sleep pass does several things:

- **Merges** near-duplicate memories ("user is from Bucharest" + "user
  lives in Romania, Bucharest" → one canonical fact).
- **Promotes** memories that keep being reinforced (something
  observed three sessions running becomes `core` tier).
- **Demotes** memories that stop being reinforced — and eventually
  retires them entirely.
- **Distills** patterns out of accumulated incidents ("the bot
  hallucinated in three separate sessions when asked about
  Romanian organised-crime figures" → "the bot should SEARCH when
  asked about post-1990s Romanian organised-crime figures").

Crucially, **decay is driven by repeatability, not by calendar
time**. A memory the bot keeps proving by encountering the same
situation stays sharp; a one-off mention that never recurs fades.
Time alone never decays a memory. Only the absence of fresh
reinforcement does.

## Self-reflection

The bot makes mistakes. A useful memory architecture lets it learn
from them in a structural sense — not just "the corrected fact is
now in the transcript" but "I now know I tend to make this kind of
mistake; next time I'll behave differently."

Reality-drift auditing (REALITY_DRIFT.md) is the mechanism:

1. After an answer streams, the fragmenter asks (in the background,
   never blocking the user) whether the answer made specific
   real-world claims with no grounding.
2. If yes, it spot-checks a handful of the claims via the RAG
   Engine's `search.run`.
3. If the search contradicts the bot, the fragmenter records the
   incident. A sleep-time appeal pass independently double-checks
   with adversarial framing before any lesson is committed.
4. Patterns across multiple confirmed incidents distill into
   behavioural lessons, stored as part of the persona's *life
   experience* chapter.
5. Those lessons ride in the persona's prompt — which means the
   orchestrator's classifier reads them too, and is more likely to
   choose SEARCH next time a similar pattern shows up.

That is the closed loop: bad answer → audit → lesson → next
classifier sees the lesson → next answer is grounded. The bot
genuinely accumulates life experience.

## The TOC + fetch architecture

This is the part the bot doesn't have yet but is the eventual
shape of the long-term memory chapters at prompt time.

The naïve approach is to dump every chapter into every prompt. That
works at the scale of "one identity fact total" but breaks the
moment the bot has lived through hundreds of sessions and
accumulated thousands of facts, lessons, and episodes. The cost is
linear in memory size, paid on every turn.

The architecture instead is a **table of contents**. At prompt
time, the bot receives:

- The always-inline chapters (persona core, current session
  summary, hot zone, `core`-tier identity facts).
- A **stub for each long-term chapter** — a few sentences saying
  what kind of knowledge is in that chapter and how much of it there
  is.

The bot reads the stubs and decides on the turn: *is the topic of
this turn covered by any of these chapters? If yes, fetch the
relevant chapter, possibly drilling into a sub-topic.*

Two layers of relevance selection:

- **Outer layer (LLM-driven):** the bot reads stubs and decides
  which chapters to fetch — agentic, context-aware, can recognise
  "the user just mentioned music and I have a 'music preferences'
  episode I should pull".
- **Inner layer (embedding-similarity, deterministic):** within a
  fetched chapter, top-K ranking by similarity to the current
  query, with `core`-tier always included regardless of score.

The fragmenter owns stub generation. When it writes a new memory
to a chapter, it regenerates the stub during the same sleep pass.
The stub is the *only* representation of the chapter the bot sees
unless it explicitly fetches.

Fallback discipline: if the bot's fetch call fails or returns
malformed output, the orchestrator degrades gracefully by rendering
the chapter's full contents — never crashes the turn. The TOC is an
optimisation; the underlying memory is always retrievable.

## What the Fragmenter is not

- **Not a search engine over external knowledge.** That is the RAG
  Engine. The fragmenter never looks at the web.
- **Not the message-persistence layer.** That is the orchestrator.
  The fragmenter reads `messages` but does not own it.
- **Not the agent reasoning loop.** Future agentic primitives may
  read the fragmenter's chapters to ground their plans, but the
  fragmenter does not itself plan, act, or call tools on the user's
  behalf.
- **Not a transcript summarizer.** Compression is a side effect, not
  the goal. The goal is *structure*.

## The long arc

The chatbot is one surface. The fragmenter, as designed, is not
chatbot-shaped — it is **memory-shaped**. The same chapters,
sleep, self-reflection, and TOC + fetch architecture work for any
agent that needs durable, organized, self-aware memory of its
interactions with the world.

The user's stated long-term arc is a Vanamonde-style agentic AI
where chat is one of many surfaces. The fragmenter is designed with
that in mind: per-user identity, per-persona experience lessons,
and cross-session conversation memory are all useful to a chatbot,
but they are *necessary* for any longer-lived agent. The architectural
choices — table-level ownership, fire-and-forget notifications,
shared SQLite, additive consolidation kinds — are sized for that
future, not for the current MVP.

This is why the fragmenter exists as its own service and is not
folded into the orchestrator. The boundary is load-bearing for the
agentic arc, even though chat alone could survive without it.

---

## Primary source — Nick's framing of the TOC + fetch architecture

Preserved verbatim. The structured sections above are organized
distillations of the idea; the original framing below carries the
intent and motivation in the user's own voice.

> is there a way to make the model see that is has long term
> memories, conversation summary, personality buildup, life
> experience, etc.? so it can choose to access one of these stores
> and retrieve more information from them? For example, at each
> prompt, the Main Model (ministral) will be given: persona,
> personality, life experience of the persona, long term memories
> of the conversation, loong term memories about the user (user
> preferences, user past reactions, etc), a summary of the
> conversation up to where the "hot", active zone begins (maybe
> 2000 tokens from last message into the past), and the hot active
> zone (last part of the conversation). But giving this much
> information at every prompt can be enormous. Every one of those
> chapters could be big, and especially the long term memories,
> both of the persona and of the conversation, can reach huge
> proportions. That's why I was thinking to have the Context
> Fragmenter prepare "stubs" for every one of these chapters. When
> it forms a long term memory, it evaluates the whole long term
> memories again and prepares a stub. We serve these stubs to the
> main model at every prompt, with the instruction that if it
> thinks that the stub matches the subject being discussed, it can
> explore further in the corresponding table of the stub. What do
> you say?
