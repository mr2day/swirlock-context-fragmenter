import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { DatabaseService } from "../database/database.service";
import { HallucinationIndexService } from "./hallucination-index.service";
import { IdentityService } from "./identity.service";
import {
  SessionSummaryService,
  type SessionSummaryRunResult,
} from "./session-summary.service";

export interface ConsolidationUpdatedEvent {
  sessionId: string;
  consolidationKind:
    | "session.summary"
    | "identity.user"
    | "identity.app"
    | "answer.reality_check"
    | "answer.hallucination_index";
  occurredAt: string;
}

interface SessionMetaRow {
  user_id: string | null;
  persona_name: string | null;
}

interface SummaryTextRow {
  summary: string;
}

interface QueuedJob {
  sessionId: string;
  lastSeq: number;
  observedAt: string;
}

export type ActivityObserver = (sessionId: string, observedAt: string) => void;

/**
 * Coordinates the fragmenter's active-mode work.
 *
 * - On `session.observed`, fire the per-turn hallucination-indexing
 *   pipeline immediately for the latest assistant message (no
 *   debounce). This is fire-and-forget — the orchestrator is not
 *   waiting on us.
 * - Same trigger also enqueues a session-summary job, debounced
 *   against `consolidation.sessionSummaryMinNewTurns`. After a
 *   summary refresh, identity extractions run for both user and
 *   persona scopes.
 * - Activity observers (the sleep/active state machine) are notified
 *   on every `session.observed` so they can keep `lastActivityAt`
 *   fresh.
 */
@Injectable()
export class ConsolidationScheduler implements OnModuleDestroy {
  private readonly log = new Logger(ConsolidationScheduler.name);
  private readonly queue = new Map<string, QueuedJob>();
  private workerRunning = false;
  private listeners: Array<(event: ConsolidationUpdatedEvent) => void> = [];
  private activityObservers: ActivityObserver[] = [];
  private destroyed = false;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly summary: SessionSummaryService,
    private readonly identity: IdentityService,
    private readonly index: HallucinationIndexService,
    private readonly db: DatabaseService,
  ) {}

  onModuleDestroy(): void {
    this.destroyed = true;
    this.queue.clear();
  }

  onConsolidationUpdated(
    listener: (event: ConsolidationUpdatedEvent) => void,
  ): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  onActivity(observer: ActivityObserver): () => void {
    this.activityObservers.push(observer);
    return () => {
      this.activityObservers = this.activityObservers.filter(
        (o) => o !== observer,
      );
    };
  }

  notifyObserved(args: {
    sessionId: string;
    lastSeq: number;
    observedAt: string;
  }): void {
    if (this.destroyed) return;

    for (const obs of this.activityObservers) {
      try {
        obs(args.sessionId, args.observedAt);
      } catch (err) {
        this.log.warn(
          `activity observer threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Per-turn hallucination index — fire immediately, do not block
    // and do not gate on the summary debounce. The index service
    // itself no-ops if the latest assistant message is already
    // indexed.
    void this.index
      .indexLatestTurn(args.sessionId)
      .then((r) => {
        if (r.status === "indexed") {
          this.emitUpdated(args.sessionId, "answer.hallucination_index");
          if (r.auditWritten === true) {
            this.emitUpdated(args.sessionId, "answer.reality_check");
          }
        }
      })
      .catch((err: Error) => {
        this.log.warn(
          `per-turn index crashed for ${args.sessionId}: ${err.message}`,
        );
      });

    const shouldRun = this.summary.shouldRun(args.sessionId, args.lastSeq);
    this.log.log(
      `notifyObserved sessionId=${args.sessionId} lastSeq=${args.lastSeq} summary.shouldRun=${shouldRun}`,
    );
    if (!shouldRun) return;
    this.enqueue(args);
    void this.drain().catch((err: Error) => {
      this.log.error(`drain crashed: ${err.message}`, err.stack);
    });
  }

  notifyInvalidated(sessionId: string): void {
    this.queue.delete(sessionId);
    try {
      this.summary.invalidateSession(sessionId);
    } catch (err) {
      this.log.warn(
        `Invalidate of session ${sessionId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private enqueue(job: QueuedJob): void {
    if (
      !this.queue.has(job.sessionId) &&
      this.queue.size >= this.cfg.consolidation.maxQueueDepth
    ) {
      this.log.warn(
        `Consolidation queue at capacity (${this.cfg.consolidation.maxQueueDepth}); dropping ${job.sessionId}`,
      );
      return;
    }
    this.queue.set(job.sessionId, job);
  }

  private async drain(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (!this.destroyed && this.queue.size > 0) {
        const next = this.queue.keys().next();
        if (next.done === true) break;
        const sessionId: string = next.value;
        const job = this.queue.get(sessionId);
        this.queue.delete(sessionId);
        if (!job) continue;

        let result: SessionSummaryRunResult;
        try {
          result = await this.summary.run(job.sessionId);
        } catch (err) {
          this.log.warn(
            `session.summary run for ${job.sessionId} threw unexpectedly: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }

        if (result.status === "updated") {
          this.emitUpdated(job.sessionId, "session.summary");
          await this.runIdentityExtractions(job.sessionId);
        }
      }
    } finally {
      this.workerRunning = false;
    }
  }

  private async runIdentityExtractions(sessionId: string): Promise<void> {
    const meta = this.loadSessionMeta(sessionId);
    if (!meta) {
      this.log.warn(
        `identity extractions skipped for ${sessionId}: session row not found`,
      );
      return;
    }
    const summaryText = this.loadSummaryText(sessionId);
    if (!summaryText) {
      this.log.warn(
        `identity extractions skipped for ${sessionId}: no summary text in DB`,
      );
      return;
    }

    if (meta.user_id) {
      try {
        const r = await this.identity.extract({
          scope: "user",
          key: meta.user_id,
          sessionSummary: summaryText,
          sourceSessionId: sessionId,
        });
        if (r.status === "updated") {
          this.emitUpdated(sessionId, "identity.user");
        }
      } catch (err) {
        this.log.warn(
          `identity.user extraction crashed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (meta.persona_name) {
      try {
        const r = await this.identity.extract({
          scope: "app",
          key: meta.persona_name,
          sessionSummary: summaryText,
          sourceSessionId: sessionId,
        });
        if (r.status === "updated") {
          this.emitUpdated(sessionId, "identity.app");
        }
      } catch (err) {
        this.log.warn(
          `identity.app extraction crashed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private emitUpdated(
    sessionId: string,
    kind: ConsolidationUpdatedEvent["consolidationKind"],
  ): void {
    const event: ConsolidationUpdatedEvent = {
      sessionId,
      consolidationKind: kind,
      occurredAt: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn(
          `consolidation.updated listener threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private loadSessionMeta(sessionId: string): SessionMetaRow | null {
    const row = this.db.connection
      .prepare(
        `SELECT user_id, persona_name FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as SessionMetaRow | undefined;
    return row ?? null;
  }

  private loadSummaryText(sessionId: string): string | null {
    const row = this.db.connection
      .prepare(
        `SELECT summary FROM fragmenter_session_summaries WHERE session_id = ?`,
      )
      .get(sessionId) as SummaryTextRow | undefined;
    return row?.summary ?? null;
  }
}
