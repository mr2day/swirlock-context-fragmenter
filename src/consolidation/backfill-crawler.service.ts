import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ConsolidationScheduler } from "./consolidation-scheduler.service";
import { SessionSummaryService } from "./session-summary.service";

interface SessionLastSeqRow {
  id: string;
  last_seq: number;
}

/**
 * On boot, walks every orchestrator session with messages and enqueues
 * the ones whose summary is missing or stale. After backfill the
 * fragmenter goes back to its normal reactive mode (driven by
 * `session.observed` from the orchestrator).
 *
 * This makes the fragmenter useful immediately on a populated database
 * — without a backfill pass, only sessions touched after the
 * fragmenter started would ever get consolidated.
 */
@Injectable()
export class BackfillCrawlerService implements OnModuleInit {
  private readonly log = new Logger(BackfillCrawlerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly summary: SessionSummaryService,
    private readonly scheduler: ConsolidationScheduler,
  ) {}

  onModuleInit(): void {
    // Defer to next tick so DatabaseService.onModuleInit has finished
    // migrating and the scheduler/summary services are fully wired.
    setImmediate(() => {
      try {
        this.run();
      } catch (err) {
        this.log.warn(
          `Backfill crawl crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  private run(): void {
    const rows = this.db.connection
      .prepare(
        `SELECT s.id AS id,
                COALESCE(MAX(m.seq), 0) AS last_seq
           FROM sessions s
           JOIN messages m ON m.session_id = s.id
          GROUP BY s.id
          ORDER BY s.updated_at DESC, s.created_at DESC`,
      )
      .all() as SessionLastSeqRow[];

    if (rows.length === 0) {
      this.log.log("Backfill: no sessions with messages — nothing to do.");
      return;
    }

    const observedAt = new Date().toISOString();
    let enqueued = 0;
    let skipped = 0;
    for (const row of rows) {
      if (row.last_seq <= 0) continue;
      if (!this.summary.shouldRun(row.id, row.last_seq)) {
        skipped += 1;
        continue;
      }
      this.scheduler.notifyObserved({
        sessionId: row.id,
        lastSeq: row.last_seq,
        observedAt,
      });
      enqueued += 1;
    }

    this.log.log(
      `Backfill: scanned ${rows.length} session(s); enqueued ${enqueued}, skipped ${skipped} (already fresh).`,
    );
  }
}
