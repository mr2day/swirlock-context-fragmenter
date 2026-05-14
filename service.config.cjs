'use strict';

/**
 * Single source of truth for the Swirlock Context Fragmenter runtime config.
 *
 * This app is co-deployed with the Chat Orchestrator on the same machine.
 * They share a single SQLite file with table-level ownership: the
 * orchestrator owns the live conversation tables (`sessions`, `messages`,
 * `agent_events`, `agent_plans`, `agent_plan_steps`, `personas`,
 * `persona_*`, `identity_mutation_candidates`); the fragmenter owns its
 * own working tables and result tables (prefixed `fragmenter_*`).
 *
 * Per Swirlock contracts v5, the orchestrator never queries the
 * fragmenter for consolidation results. Consolidation is read directly
 * from the shared SQLite file by the orchestrator at prompt-assembly
 * time. The orchestrator only sends fire-and-forget notifications
 * (`session.observed`, `session.invalidate`) over a persistent
 * WebSocket; the fragmenter optionally pushes back `consolidation.updated`
 * events.
 */

const path = require('path');

const env = {
  serviceName: 'swirlock-context-fragmenter',

  // WebSocket listener. Endpoint path is /v5/fragmenter.
  host: '127.0.0.1',
  port: 3215,

  // Bearer token expected on the inbound WebSocket from the orchestrator.
  // Must match the orchestrator's `fragmenter.bearerToken` config.
  bearerToken: 'dev-token-change-me',

  // Shared SQLite database file. MUST point at the orchestrator's
  // SQLite file. Co-location is an architectural assumption in v5;
  // both processes run on the same machine and SQLite WAL mode handles
  // concurrent access safely as long as table-level ownership is
  // respected.
  database: {
    file: path.resolve(
      __dirname,
      '..',
      'swirlock-chat-orchestrator',
      'data',
      'chat-orchestrator.sqlite',
    ),
  },

  // Fragmenter LLM Host. Per the v5 1:1 module-to-LLM rule, the
  // fragmenter consumes exactly one Model Host. The connection target
  // is a single Model Host process at the URL below; the fragmenter
  // never decides at runtime which of multiple Model Hosts to call.
  llmHost: {
    baseUrl: 'http://192.168.0.194:3213',
    callerService: 'context-fragmenter',
    timeoutMs: 120000,
  },

  // RAG Engine peer. The fragmenter opens a persistent WS to this
  // endpoint and consumes the thin `search.run` capability for
  // reality-drift spot-checks. Per v5 contract Q1, the fragmenter
  // never bundles its own Exa client; all web-search goes through
  // the RAG Engine.
  ragEngine: {
    baseUrl: 'http://127.0.0.1:3001',
    callerService: 'context-fragmenter',
    timeoutMs: 60000,
  },

  // Consolidation knobs. Tuned conservatively for the MVP; one
  // consolidation kind exists today (`session.summary`).
  consolidation: {
    // Minimum number of new turns since the last summary before
    // running again. Below this threshold, `session.observed` events
    // are debounced and a re-summarization is not scheduled.
    sessionSummaryMinNewTurns: 3,

    // Maximum number of recent messages to feed into the summary
    // prompt. The fragmenter prepends a high-level "summary so far"
    // line if a previous summary exists, so this only needs to cover
    // the *recent* portion of the conversation.
    sessionSummaryMaxRecentMessages: 24,

    // Hard cap on outstanding consolidation jobs queued in memory.
    // Older jobs for the same sessionId are coalesced.
    maxQueueDepth: 256,

    // How often the identity-consolidation ("sleep") job runs, in
    // milliseconds. The job walks all active user_identities and
    // app_identities and asks the LLM to merge/dedupe/re-tier them.
    // Default: every 30 minutes. Set to 0 to disable.
    sleepIntervalMs: 30 * 60 * 1000,

    // Repeatability-driven decay (Unit B). How many sleep-tick
    // durations a fact may go without reinforcement before being
    // demoted (or retired, if already incidental). 336 ticks at
    // 30-min cadence = 7 days of barren time before any decay
    // fires. Tunable per deployment.
    decayBarrenTicks: 336,

    // How many reinforcements a row needs to climb one importance
    // tier. incidental -> important requires this many; important
    // -> core requires twice this many. Reinforcement happens when
    // a fresh extraction's content matches an existing active
    // row's content (case + whitespace normalised).
    promotionReinforcementThreshold: 3,

    // Unit C: reality-drift Layer-1 structural pre-filter
    // thresholds. The gate is a candidate for the Layer-2 LLM
    // decision only when ALL of these hold for the just-finished
    // assistant turn:
    //   1. No SEARCH ran for that turn
    //   2. Message length >= minChars
    //   3. At least one specifics-density counter clears its
    //      per-1000-char floor (year tokens OR digit+word tokens
    //      OR quoted substrings without a co-located URL)
    // Defaults are deliberately permissive at MVP — we want to see
    // false positives in the log and tune from there, rather than
    // miss real hallucinations.
    realityDriftGate: {
      minChars: 600,
      yearTokensPer1kChars: 1.5,
      digitWordTokensPer1kChars: 2.0,
      quotedSubstringsPer1kChars: 0.5,
    },
  },
};

module.exports = { env };
