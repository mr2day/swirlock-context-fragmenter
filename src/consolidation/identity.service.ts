import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { DatabaseService } from "../database/database.service";
import { LlmHostService } from "../llm-host/llm-host.service";
import {
  buildIdentityExtractionMessages,
  buildIdentityMergeMessages,
  parseExtractedFacts,
  type ExtractedFact,
  type ImportanceTier,
} from "./identity-prompt-builder";

export type IdentityScope = "user" | "app";

interface IdentityRow {
  id: string;
  content: string;
  importance: ImportanceTier;
  source_kind: string;
  source_session_id: string | null;
  generated_at: string;
  superseded_at: string | null;
}

export interface IdentityExtractionResult {
  scope: IdentityScope;
  key: string;
  insertedCount: number;
  reinforcedCount: number;
  status: "updated" | "no_change" | "failed" | "skipped";
  reason?: string;
}

export interface IdentityDecayResult {
  scope: IdentityScope;
  demoted: number;
  retired: number;
  promoted: number;
}

export interface IdentityMergeResult {
  scope: IdentityScope;
  key: string;
  beforeCount: number;
  afterCount: number;
  status: "merged" | "no_change" | "failed" | "skipped";
  reason?: string;
}

/**
 * Owns extraction and consolidation of durable identity facts.
 *
 * One instance handles both user identities (keyed by user_id, table
 * `fragmenter_user_identities`) and app identities (keyed by
 * persona_name, table `fragmenter_app_identities`). The two flows are
 * identical in shape; only the table and key column change.
 */
@Injectable()
export class IdentityService {
  private readonly log = new Logger(IdentityService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
  ) {}

  /**
   * Runs an extraction pass for the given (scope, key) using the
   * latest available session summary as raw material. Idempotent at
   * the row level (each call inserts new rows; duplicates by content
   * are deduplicated against active rows before insertion).
   */
  async extract(args: {
    scope: IdentityScope;
    key: string;
    sessionSummary: string;
    sourceSessionId: string;
  }): Promise<IdentityExtractionResult> {
    const { scope, key, sessionSummary, sourceSessionId } = args;
    if (!key.trim()) {
      return {
        scope,
        key,
        insertedCount: 0,
        reinforcedCount: 0,
        status: "skipped",
        reason: "empty key",
      };
    }
    if (!sessionSummary.trim()) {
      return {
        scope,
        key,
        insertedCount: 0,
        reinforcedCount: 0,
        status: "skipped",
        reason: "empty session summary",
      };
    }

    const existing = this.loadActiveFacts(scope, key);
    const messages = buildIdentityExtractionMessages({
      subject: scope === "user" ? "user" : "assistant",
      sessionSummary,
      existingFacts: existing.map((r) => ({
        content: r.content,
        importance: r.importance,
      })),
    });

    const correlationId = `cf:identity:${scope}:${randomUUID()}`;

    let llmText: string;
    try {
      const result = await this.llm.streamInfer({
        correlationId,
        messages,
        options: {
          responseFormat: "json",
          thinking: false,
          ollama: { temperature: 0.2 },
        },
      });
      llmText = result.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `identity.extract ${scope}/${key} failed: ${reason}`,
      );
      return {
        scope,
        key,
        insertedCount: 0,
        reinforcedCount: 0,
        status: "failed",
        reason,
      };
    }

    const extracted = parseExtractedFacts(llmText);
    this.log.log(
      `identity.extract ${scope}/${key} LLM returned ${extracted.length} fact(s). Raw length=${llmText.length}.`,
    );
    if (extracted.length === 0) {
      // Log a clipped preview of the raw response so we can see what
      // the LLM produced when the parser couldn't extract anything.
      const preview = llmText.replace(/\s+/g, " ").slice(0, 400);
      this.log.warn(
        `identity.extract ${scope}/${key} parsed 0 facts. raw preview: ${preview}`,
      );
      return {
        scope,
        key,
        insertedCount: 0,
        reinforcedCount: 0,
        status: "no_change",
      };
    }

    // Split the LLM's output into rows that match an existing active
    // fact (reinforcement) and rows that are genuinely new (insertion).
    // Reinforcement matters for Unit B's repeatability-driven decay:
    // a fact the user keeps establishing across sessions accumulates
    // reinforcement_count and last_confirmed_at, which lets the sleep
    // pass promote it and protects it from decay.
    const existingByKey = new Map<string, IdentityRow>();
    for (const row of existing) {
      existingByKey.set(normalizeContent(row.content), row);
    }
    const fresh: ExtractedFact[] = [];
    const reinforceIds: string[] = [];
    for (const f of extracted) {
      const match = existingByKey.get(normalizeContent(f.content));
      if (match) {
        reinforceIds.push(match.id);
      } else {
        fresh.push(f);
      }
    }

    let reinforced = 0;
    if (reinforceIds.length > 0) {
      reinforced = this.reinforceFacts(scope, reinforceIds);
    }

    let inserted = 0;
    if (fresh.length > 0) {
      inserted = this.insertFacts(scope, key, fresh, {
        sourceKind: "session_extraction",
        sourceSessionId,
        correlationId,
      });
    }

    this.log.log(
      `identity.extract ${scope}/${key} inserted ${inserted}, reinforced ${reinforced} (had ${existing.length}, llm returned ${extracted.length}).`,
    );

    return {
      scope,
      key,
      insertedCount: inserted,
      reinforcedCount: reinforced,
      // 'updated' only when content actually changed — pure reinforcement
      // doesn't change the prompt-visible view, so the orchestrator does
      // not need to invalidate caches.
      status: inserted > 0 ? "updated" : "no_change",
    };
  }

  /**
   * Sleep-merge pass for one (scope, key): re-prompts the LLM with the
   * full active fact set and rewrites it consolidated. Old rows are
   * marked superseded and pointed to the new ones.
   */
  async merge(args: {
    scope: IdentityScope;
    key: string;
  }): Promise<IdentityMergeResult> {
    const { scope, key } = args;
    const existing = this.loadActiveFacts(scope, key);
    if (existing.length === 0) {
      return {
        scope,
        key,
        beforeCount: 0,
        afterCount: 0,
        status: "skipped",
        reason: "no active facts",
      };
    }
    if (existing.length < 2) {
      // Nothing meaningful to merge with a single fact.
      return {
        scope,
        key,
        beforeCount: existing.length,
        afterCount: existing.length,
        status: "no_change",
      };
    }

    const messages = buildIdentityMergeMessages({
      subject: scope === "user" ? "user" : "assistant",
      currentFacts: existing.map((r) => ({
        content: r.content,
        importance: r.importance,
      })),
    });
    const correlationId = `cf:identity-merge:${scope}:${randomUUID()}`;

    let llmText: string;
    try {
      const result = await this.llm.streamInfer({
        correlationId,
        messages,
        options: {
          responseFormat: "json",
          thinking: false,
          ollama: { temperature: 0.1 },
        },
      });
      llmText = result.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`identity.merge ${scope}/${key} failed: ${reason}`);
      return {
        scope,
        key,
        beforeCount: existing.length,
        afterCount: existing.length,
        status: "failed",
        reason,
      };
    }

    const merged = parseExtractedFacts(llmText);
    if (merged.length === 0) {
      // LLM returned empty list; treat as a parse failure rather than
      // wiping the user's identity. Sleep retries on the next pass.
      return {
        scope,
        key,
        beforeCount: existing.length,
        afterCount: existing.length,
        status: "failed",
        reason: "merge output was empty",
      };
    }

    const supersededAt = new Date().toISOString();
    const txn = this.db.connection.transaction(() => {
      const newRows = this.insertFacts(scope, key, merged, {
        sourceKind: "sleep_merge",
        sourceSessionId: null,
        correlationId,
      });
      // Mark all previously-active rows as superseded.
      const newRowIds = this.loadActiveFacts(scope, key)
        .filter((r) => !existing.some((e) => e.id === r.id))
        .map((r) => r.id);
      const placeholder = newRowIds[0] ?? null;
      for (const old of existing) {
        this.markSuperseded(scope, old.id, supersededAt, placeholder);
      }
      return newRows;
    });

    let inserted = 0;
    try {
      inserted = txn();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`identity.merge ${scope}/${key} db txn failed: ${reason}`);
      return {
        scope,
        key,
        beforeCount: existing.length,
        afterCount: existing.length,
        status: "failed",
        reason,
      };
    }

    this.log.log(
      `identity.merge ${scope}/${key}: ${existing.length} → ${inserted} fact(s).`,
    );

    return {
      scope,
      key,
      beforeCount: existing.length,
      afterCount: inserted,
      status: "merged",
    };
  }

  /**
   * Lists every (scope, key) pair that currently has at least one
   * active fact. Used by the sleep job.
   */
  listActiveKeys(scope: IdentityScope): string[] {
    const { table, keyCol } = this.tableInfo(scope);
    const rows = this.db.connection
      .prepare(
        `SELECT DISTINCT ${keyCol} AS k
           FROM ${table}
          WHERE superseded_at IS NULL`,
      )
      .all() as Array<{ k: string }>;
    return rows.map((r) => r.k);
  }

  /**
   * Removes all rows (active and superseded) for a given key. Called
   * indirectly by session.invalidate when sessions for a user are
   * deleted en masse — kept here for completeness; not used yet.
   */
  invalidate(scope: IdentityScope, key: string): void {
    const { table, keyCol } = this.tableInfo(scope);
    this.db.connection
      .prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`)
      .run(key);
  }

  /**
   * Unit B: repeatability-driven decay + promotion pass over all
   * active rows in a scope. Runs once per sleep tick, after the
   * LLM-driven merge pass.
   *
   * Decay rule (time-driven):
   *  - Any active row whose `last_confirmed_at` is older than
   *    `decayBarrenTicks * quietThresholdMs` is decayed one tier.
   *  - `core` -> `important`, `important` -> `incidental`,
   *    `incidental` -> retired (superseded_at set).
   *  - On decay we reset `last_confirmed_at = now` and
   *    `reinforcement_count = 0` so the row gets another full barren
   *    window before the next decay step fires, and so promotion
   *    requires fresh reinforcements rather than counting historical
   *    ones.
   *
   * Promotion rule (count-driven):
   *  - `incidental` rows with `reinforcement_count >=
   *    promotionReinforcementThreshold` are promoted to `important`.
   *  - `important` rows with `reinforcement_count >=
   *    2 * promotionReinforcementThreshold` are promoted to `core`.
   *  - Promotion resets `reinforcement_count = 0` so a new tier has
   *    to be earned fresh.
   *
   * Decay and promotion are mutually exclusive: a row that's
   * eligible to decay (barren) cannot also be eligible to promote in
   * the same tick, because we run decay first and decay resets
   * `reinforcement_count`.
   */
  applyDecayPass(scope: IdentityScope): IdentityDecayResult {
    const { table } = this.tableInfo(scope);
    const quietThreshold = this.cfg.consolidation.quietThresholdMs;
    const barrenTicks = this.cfg.consolidation.decayBarrenTicks;
    const promoteThreshold = this.cfg.consolidation.promotionReinforcementThreshold;
    const now = new Date();
    const nowIso = now.toISOString();
    const decayCutoffMs = now.getTime() - quietThreshold * barrenTicks;
    const decayCutoffIso = new Date(decayCutoffMs).toISOString();

    const txn = this.db.connection.transaction(() => {
      // Retire `incidental` rows that have gone barren.
      const retireStmt = this.db.connection.prepare(
        `UPDATE ${table}
            SET superseded_at = ?
          WHERE superseded_at IS NULL
            AND importance = 'incidental'
            AND last_confirmed_at IS NOT NULL
            AND last_confirmed_at < ?`,
      );
      const retired = retireStmt.run(nowIso, decayCutoffIso).changes;

      // Demote `core` / `important` barren rows one tier; reset the
      // barren clock and reinforcement counter so the new tier has a
      // fresh window.
      const demoteStmt = this.db.connection.prepare(
        `UPDATE ${table}
            SET importance = CASE importance
                  WHEN 'core' THEN 'important'
                  WHEN 'important' THEN 'incidental'
                  ELSE importance
                END,
                last_confirmed_at = ?,
                reinforcement_count = 0
          WHERE superseded_at IS NULL
            AND importance IN ('core', 'important')
            AND last_confirmed_at IS NOT NULL
            AND last_confirmed_at < ?`,
      );
      const demoted = demoteStmt.run(nowIso, decayCutoffIso).changes;

      // Promote `important` rows that have accumulated enough
      // reinforcements (2x threshold). Reset reinforcement_count.
      const promoteToCoreStmt = this.db.connection.prepare(
        `UPDATE ${table}
            SET importance = 'core',
                reinforcement_count = 0
          WHERE superseded_at IS NULL
            AND importance = 'important'
            AND reinforcement_count >= ?`,
      );
      const promotedToCore = promoteToCoreStmt.run(
        promoteThreshold * 2,
      ).changes;

      // Promote `incidental` rows that have accumulated enough
      // reinforcements. Reset reinforcement_count.
      const promoteToImportantStmt = this.db.connection.prepare(
        `UPDATE ${table}
            SET importance = 'important',
                reinforcement_count = 0
          WHERE superseded_at IS NULL
            AND importance = 'incidental'
            AND reinforcement_count >= ?`,
      );
      const promotedToImportant = promoteToImportantStmt.run(
        promoteThreshold,
      ).changes;

      return {
        demoted,
        retired,
        promoted: promotedToCore + promotedToImportant,
      };
    });

    return { scope, ...txn() };
  }

  private loadActiveFacts(
    scope: IdentityScope,
    key: string,
  ): IdentityRow[] {
    const { table, keyCol } = this.tableInfo(scope);
    return this.db.connection
      .prepare(
        `SELECT id, content, importance, source_kind, source_session_id,
                generated_at, superseded_at
           FROM ${table}
          WHERE ${keyCol} = ? AND superseded_at IS NULL
          ORDER BY
            CASE importance
              WHEN 'core' THEN 0
              WHEN 'important' THEN 1
              ELSE 2
            END,
            generated_at ASC`,
      )
      .all(key) as IdentityRow[];
  }

  private insertFacts(
    scope: IdentityScope,
    key: string,
    facts: ExtractedFact[],
    meta: {
      sourceKind: "session_extraction" | "sleep_merge";
      sourceSessionId: string | null;
      correlationId: string;
    },
  ): number {
    if (facts.length === 0) return 0;
    const { table, keyCol } = this.tableInfo(scope);
    const stmt = this.db.connection.prepare(
      `INSERT INTO ${table}
         (id, ${keyCol}, content, importance, source_kind, source_session_id, generated_at, last_confirmed_at, fragmenter_correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    let count = 0;
    for (const fact of facts) {
      stmt.run(
        randomUUID(),
        key,
        fact.content,
        fact.importance,
        meta.sourceKind,
        meta.sourceSessionId,
        now,
        now,
        meta.correlationId,
      );
      count += 1;
    }
    return count;
  }

  private markSuperseded(
    scope: IdentityScope,
    rowId: string,
    supersededAt: string,
    supersededById: string | null,
  ): void {
    const { table } = this.tableInfo(scope);
    this.db.connection
      .prepare(
        `UPDATE ${table}
            SET superseded_at = ?, superseded_by_id = ?
          WHERE id = ?`,
      )
      .run(supersededAt, supersededById, rowId);
  }

  /**
   * Unit B: bumps `last_confirmed_at` and `reinforcement_count` for
   * each given row id. Called from `extract()` when a fresh LLM
   * extraction's content matches an existing active row.
   */
  private reinforceFacts(scope: IdentityScope, rowIds: string[]): number {
    if (rowIds.length === 0) return 0;
    const { table } = this.tableInfo(scope);
    const stmt = this.db.connection.prepare(
      `UPDATE ${table}
          SET last_confirmed_at = ?,
              reinforcement_count = reinforcement_count + 1
        WHERE id = ?`,
    );
    const now = new Date().toISOString();
    let count = 0;
    for (const id of rowIds) {
      const result = stmt.run(now, id);
      count += result.changes;
    }
    return count;
  }

  private tableInfo(scope: IdentityScope): { table: string; keyCol: string } {
    return scope === "user"
      ? { table: "fragmenter_user_identities", keyCol: "user_id" }
      : { table: "fragmenter_app_identities", keyCol: "persona_name" };
  }
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}
