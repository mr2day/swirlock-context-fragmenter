import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import {
  SessionSummaryService,
  type SessionSummaryRunResult,
} from "./session-summary.service";

export interface ConsolidationUpdatedEvent {
  sessionId: string;
  consolidationKind: "session.summary";
  occurredAt: string;
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
          const event: ConsolidationUpdatedEvent = {
            sessionId: job.sessionId,
            consolidationKind: "session.summary",
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
      }
    } finally {
      this.workerRunning = false;
    }
  }
}
