import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { DatabaseService } from "../database/database.service";
import { LlmHostService } from "../llm-host/llm-host.service";
import { buildSessionSummaryMessages } from "./session-summary-prompt-builder";

interface OrchestratorMessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  seq: number;
}

interface SummaryRow {
  session_id: string;
  summary: string;
  through_seq: number;
  through_message_id: string | null;
  generated_at: string;
}

export interface SessionSummaryRunResult {
  sessionId: string;
  status: "updated" | "skipped_no_progress" | "skipped_no_messages" | "failed";
  throughSeq: number | null;
  reason?: string;
}

/**
 * Owns the rolling session summary consolidation.
 *
 * Reads orchestrator-owned tables (`messages`, `sessions`) and writes
 * to fragmenter-owned tables (`fragmenter_session_summaries`,
 * `fragmenter_consolidation_runs`). Per the v5 table-ownership rule,
 * this service is the only writer for those fragmenter tables.
 */
@Injectable()
export class SessionSummaryService {
  private readonly log = new Logger(SessionSummaryService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
  ) {}

  /**
   * Decides whether a re-summarization is worth running for `sessionId`.
   * The fragmenter never runs an LLM call eagerly on every observation;
   * it debounces against `consolidation.sessionSummaryMinNewTurns`.
   */
  shouldRun(sessionId: string, currentLastSeq: number): boolean {
    const previous = this.loadSummary(sessionId);
    if (!previous) return currentLastSeq > 0;
    const delta = currentLastSeq - previous.through_seq;
    return delta >= this.cfg.consolidation.sessionSummaryMinNewTurns;
  }

  async run(sessionId: string): Promise<SessionSummaryRunResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    this.log.log(`session.summary run started for ${sessionId} (runId=${runId})`);

    this.recordRunStart(runId, sessionId, startedAt);

    const previous = this.loadSummary(sessionId);
    const recent = this.loadRecentMessages(
      sessionId,
      this.cfg.consolidation.sessionSummaryMaxRecentMessages,
    );

    if (recent.length === 0) {
      this.recordRunFinish(runId, "skipped_no_messages", null);
      return {
        sessionId,
        status: "skipped_no_messages",
        throughSeq: null,
      };
    }

    const lastSeq = recent[recent.length - 1].seq;
    if (previous && previous.through_seq >= lastSeq) {
      this.recordRunFinish(runId, "skipped_no_progress", previous.through_seq);
      return {
        sessionId,
        status: "skipped_no_progress",
        throughSeq: previous.through_seq,
      };
    }

    const olderTurnCount = previous
      ? this.countOlderMessages(sessionId, recent[0].seq)
      : 0;

    const messages = buildSessionSummaryMessages({
      recentMessages: recent.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
      previousSummary: previous?.summary ?? null,
      olderTurnCount,
    });

    const correlationId = `cf:${runId}`;

    let summaryText: string;
    try {
      const result = await this.llm.streamInfer({
        correlationId,
        messages,
        options: {
          responseFormat: "text",
          thinking: false,
          ollama: { temperature: 0.2 },
        },
      });
      summaryText = result.text.trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `session.summary run failed for ${sessionId}: ${message}`,
      );
      this.recordRunFailure(runId, message);
      return {
        sessionId,
        status: "failed",
        throughSeq: null,
        reason: message,
      };
    }

    if (!summaryText) {
      const reason = "Fragmenter LLM returned empty summary text";
      this.recordRunFailure(runId, reason);
      return {
        sessionId,
        status: "failed",
        throughSeq: null,
        reason,
      };
    }

    const lastMessage = recent[recent.length - 1];
    const generatedAt = new Date().toISOString();

    this.upsertSummary({
      sessionId,
      summary: summaryText,
      throughSeq: lastMessage.seq,
      throughMessageId: lastMessage.id,
      generatedAt,
      correlationId,
    });
    this.recordRunFinish(runId, "updated", lastMessage.seq);

    this.log.log(
      `session.summary updated for ${sessionId} (through seq ${lastMessage.seq}, ${summaryText.length} chars)`,
    );

    return {
      sessionId,
      status: "updated",
      throughSeq: lastMessage.seq,
    };
  }

  invalidateSession(sessionId: string): void {
    this.db.connection
      .prepare(`DELETE FROM fragmenter_session_summaries WHERE session_id = ?`)
      .run(sessionId);
    this.db.connection
      .prepare(`DELETE FROM fragmenter_consolidation_runs WHERE session_id = ?`)
      .run(sessionId);
  }

  private loadSummary(sessionId: string): SummaryRow | null {
    const row = this.db.connection
      .prepare(
        `SELECT session_id, summary, through_seq, through_message_id, generated_at
           FROM fragmenter_session_summaries
          WHERE session_id = ?`,
      )
      .get(sessionId) as SummaryRow | undefined;
    return row ?? null;
  }

  private loadRecentMessages(
    sessionId: string,
    limit: number,
  ): OrchestratorMessageRow[] {
    const rows = this.db.connection
      .prepare(
        `SELECT id, role, content, created_at, seq
           FROM messages
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as OrchestratorMessageRow[];
    return rows.reverse();
  }

  private countOlderMessages(
    sessionId: string,
    oldestIncludedSeq: number,
  ): number {
    const row = this.db.connection
      .prepare(
        `SELECT COUNT(*) AS c
           FROM messages
          WHERE session_id = ? AND seq < ?`,
      )
      .get(sessionId, oldestIncludedSeq) as { c: number };
    return row.c;
  }

  private upsertSummary(args: {
    sessionId: string;
    summary: string;
    throughSeq: number;
    throughMessageId: string;
    generatedAt: string;
    correlationId: string;
  }): void {
    this.db.connection
      .prepare(
        `INSERT INTO fragmenter_session_summaries
           (session_id, summary, through_seq, through_message_id, generated_at, fragmenter_correlation_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summary = excluded.summary,
           through_seq = excluded.through_seq,
           through_message_id = excluded.through_message_id,
           generated_at = excluded.generated_at,
           fragmenter_correlation_id = excluded.fragmenter_correlation_id`,
      )
      .run(
        args.sessionId,
        args.summary,
        args.throughSeq,
        args.throughMessageId,
        args.generatedAt,
        args.correlationId,
      );
  }

  private recordRunStart(
    runId: string,
    sessionId: string,
    startedAt: string,
  ): void {
    this.db.connection
      .prepare(
        `INSERT INTO fragmenter_consolidation_runs
           (id, session_id, kind, status, started_at)
         VALUES (?, ?, 'session.summary', 'running', ?)`,
      )
      .run(runId, sessionId, startedAt);
  }

  private recordRunFinish(
    runId: string,
    status: SessionSummaryRunResult["status"],
    throughSeq: number | null,
  ): void {
    this.db.connection
      .prepare(
        `UPDATE fragmenter_consolidation_runs
            SET status = ?, finished_at = ?, through_seq = ?
          WHERE id = ?`,
      )
      .run(status, new Date().toISOString(), throughSeq, runId);
  }

  private recordRunFailure(runId: string, message: string): void {
    this.db.connection
      .prepare(
        `UPDATE fragmenter_consolidation_runs
            SET status = 'failed', finished_at = ?, error_message = ?
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), message, runId);
  }
}
