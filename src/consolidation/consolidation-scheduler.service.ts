import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { DatabaseService } from "../database/database.service";
import { IdentityService } from "./identity.service";
import { RealityDriftAuditService } from "./reality-drift-audit.service";
import { RealityDriftGateService } from "./reality-drift-gate.service";
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
    | "answer.reality_check";
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

/**
 * Coordinates when consolidation work runs.
 *
 * The scheduler is intentionally simple in the MVP:
 *
 * - On `session.observed`, decide whether the session has accumulated
 *   enough new turns to justify a new summary (debounce against the
 *   contracted `sessionSummaryMinNewTurns` threshold).
 * - If yes, enqueue a job. The job is keyed by `sessionId` — repeated
 *   observations for the same session coalesce into a single pending
 *   job (last-seen `lastSeq`/`observedAt` win).
 * - A single worker drains the queue. Concurrent runs for the *same*
 *   session never happen; concurrent runs for *different* sessions also
 *   don't happen (the LLM Host serializes its own queue and the SQLite
 *   write path is fast enough that running them in series is fine for
 *   MVP-scale loads).
 *
 * `priority` is currently always `background`; the v5 contract reserves
 * `maintenance` for deeper consolidation kinds we don't run yet.
 */
@Injectable()
export class ConsolidationScheduler implements OnModuleDestroy {
  private readonly log = new Logger(ConsolidationScheduler.name);
  private readonly queue = new Map<string, QueuedJob>();
  private workerRunning = false;
  private listeners: Array<(event: ConsolidationUpdatedEvent) => void> = [];
  private destroyed = false;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly summary: SessionSummaryService,
    private readonly identity: IdentityService,
    private readonly gate: RealityDriftGateService,
    private readonly audit: RealityDriftAuditService,
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

  notifyObserved(args: {
    sessionId: string;
    lastSeq: number;
    observedAt: string;
  }): void {
    if (this.destroyed) return;
    const shouldRun = this.summary.shouldRun(args.sessionId, args.lastSeq);
    this.log.log(
      `notifyObserved sessionId=${args.sessionId} lastSeq=${args.lastSeq} shouldRun=${shouldRun}`,
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

          // After the rolling session summary refreshes, run identity
          // extractions for both the user and the persona using that
          // fresh summary as raw material. These are best-effort: any
          // failure is logged and skipped without aborting the worker.
          await this.runIdentityExtractions(job.sessionId);

          // Unit C — reality-drift gate (Layer 1 + Layer 2). Unit D
          // — when the gate marks the turn audit-worthy, run the
          // spot-check audit pipeline (claim extraction →
          // search.run → adjudication → corrected_summary → persist).
          // Both stages are best-effort: failures don't abort the
          // worker.
          try {
            const decision = await this.gate.evaluateLatestTurn(job.sessionId);
            if (
              decision &&
              decision.layer2?.attempted &&
              decision.layer2.succeeded &&
              decision.layer2.auditWorthy === true
            ) {
              try {
                const result = await this.audit.auditTurn(
                  decision,
                  decision.assistantMessageContent,
                );
                if (result.status === "written") {
                  this.emitUpdated(job.sessionId, "answer.reality_check");
                }
              } catch (err) {
                this.log.warn(
                  `reality-drift audit crashed for ${job.sessionId}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
          } catch (err) {
            this.log.warn(
              `reality-drift gate crashed for ${job.sessionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
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
