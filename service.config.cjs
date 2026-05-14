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
  },
};

module.exports = { env };
