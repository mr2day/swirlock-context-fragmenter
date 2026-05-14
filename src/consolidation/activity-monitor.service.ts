import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { ConsolidationScheduler } from "./consolidation-scheduler.service";
import { SleepService } from "./sleep.service";

const TICK_INTERVAL_MS = 30_000;

type Mode = "active" | "sleeping" | "slept";

/**
 * Active/sleep state machine for the fragmenter.
 *
 * On boot the fragmenter is "active" — it does per-turn work
 * (hallucination indexing + session-summary refresh + identity
 * extraction) inline as `session.observed` events arrive. The
 * monitor records the timestamp of every observed event.
 *
 * Once `now - lastActivityAt > quietThresholdMs`, the monitor flips
 * to "sleeping" and runs `SleepService.tick()` once. After the tick
 * completes the mode becomes "slept" and stays there until the next
 * `session.observed` arrives — at which point it flips back to
 * "active" and the cycle starts over.
 *
 * The monitor itself uses a single setInterval (30s) to evaluate
 * the state machine. The interval is not a sleep cadence — sleep
 * runs at most once per quiet window, not once per check.
 */
@Injectable()
export class ActivityMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ActivityMonitorService.name);
  private mode: Mode = "active";
  private lastActivityAt: number = Date.now();
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private unsubscribe?: () => void;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly scheduler: ConsolidationScheduler,
    private readonly sleep: SleepService,
  ) {}

  onModuleInit(): void {
    const quietMs = this.cfg.consolidation.quietThresholdMs;
    this.log.log(
      `Activity monitor armed: quiet threshold ${Math.round(quietMs / 60_000)} min; mode=${this.mode}.`,
    );
    this.unsubscribe = this.scheduler.onActivity((sessionId, observedAt) => {
      this.recordActivity(sessionId, observedAt);
    });
    this.timer = setInterval(() => {
      void this.evaluate().catch((err: Error) => {
        this.log.warn(`activity monitor evaluate crashed: ${err.message}`);
      });
    }, TICK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /** Visible for diagnostics. */
  currentMode(): Mode {
    return this.mode;
  }

  /** Visible for diagnostics. */
  msSinceLastActivity(): number {
    return Date.now() - this.lastActivityAt;
  }

  private recordActivity(sessionId: string, observedAt: string): void {
    this.lastActivityAt = Date.now();
    if (this.mode !== "active") {
      this.log.log(
        `mode active <- ${this.mode} (sessionId=${sessionId} observedAt=${observedAt})`,
      );
      this.mode = "active";
    }
  }

  private async evaluate(): Promise<void> {
    if (this.destroyed) return;
    const quietMs = this.cfg.consolidation.quietThresholdMs;
    const idleFor = Date.now() - this.lastActivityAt;

    if (this.mode === "active" && idleFor >= quietMs) {
      this.mode = "sleeping";
      this.log.log(
        `mode sleeping <- active (idle ${Math.round(idleFor / 60_000)} min >= threshold ${Math.round(quietMs / 60_000)} min)`,
      );
      try {
        await this.sleep.tick();
      } catch (err) {
        this.log.warn(
          `sleep tick crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Activity that arrived during the tick will have flipped mode
      // back to "active" via recordActivity. Only mark slept if we
      // are still in sleeping mode at the end.
      if (this.mode === "sleeping") {
        this.mode = "slept";
        this.log.log("mode slept <- sleeping (tick complete; waiting for next activity)");
      }
    }
  }
}
