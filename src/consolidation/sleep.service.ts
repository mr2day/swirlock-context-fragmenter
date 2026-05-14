import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { IdentityService } from "./identity.service";
import { RealityDriftAppealService } from "./reality-drift-appeal.service";

/**
 * Periodic identity-consolidation job.
 *
 * In the v1 vision this is called "sleep": a scheduled pass that
 * re-reads every active identity fact for each (scope, key) pair,
 * asks the LLM to merge duplicates, drop subsumed incidentals, and
 * re-tier the survivors, then writes the consolidated list back and
 * supersedes the old rows.
 *
 * The MVP cadence is configurable (`consolidation.sleepIntervalMs`).
 * Runs serially across scopes/keys to keep LLM-host pressure low.
 */
@Injectable()
export class SleepService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SleepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private destroyed = false;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly identity: IdentityService,
    private readonly appeal: RealityDriftAppealService,
  ) {}

  onModuleInit(): void {
    const interval = this.cfg.consolidation.sleepIntervalMs;
    if (!Number.isFinite(interval) || interval <= 0) {
      this.log.log(
        "Sleep job disabled (consolidation.sleepIntervalMs is 0 or unset).",
      );
      return;
    }
    this.log.log(
      `Sleep job scheduled every ${Math.round(interval / 60_000)} min.`,
    );
    this.timer = setInterval(() => {
      void this.tick().catch((err: Error) => {
        this.log.warn(`sleep tick crashed: ${err.message}`);
      });
    }, interval);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.log.log("sleep tick already running; skipping.");
      return;
    }
    this.running = true;
    try {
      await this.consolidateScope("user");
      await this.consolidateScope("app");

      // Unit E — appeal pass over hallucinated/suspect audits that
      // have not been appealed yet. Best-effort: failures don't
      // abort the tick.
      try {
        await this.appeal.runOutstandingAppeals();
      } catch (err) {
        this.log.warn(
          `sleep appeal pass crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async consolidateScope(scope: "user" | "app"): Promise<void> {
    const keys = this.identity.listActiveKeys(scope);
    if (keys.length === 0) {
      this.log.log(`sleep: no active ${scope} identities to consolidate.`);
      // Still run the decay pass — there may be no active keys
      // *because* prior rows just decayed below the activity bar.
      // Cheap SQL, no LLM call.
      this.runDecayPass(scope);
      return;
    }
    this.log.log(
      `sleep: consolidating ${scope} identities for ${keys.length} key(s).`,
    );
    let merged = 0;
    for (const key of keys) {
      if (this.destroyed) return;
      try {
        const r = await this.identity.merge({ scope, key });
        if (r.status === "merged") merged += 1;
      } catch (err) {
        this.log.warn(
          `sleep merge ${scope}/${key} crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.log.log(
      `sleep: ${scope} merge pass done; merged ${merged}/${keys.length} key(s).`,
    );

    // Unit B: repeatability-driven decay + promotion. Runs once per
    // scope, after merges, before next tick. Pure SQL, no LLM call.
    this.runDecayPass(scope);
  }

  private runDecayPass(scope: "user" | "app"): void {
    try {
      const decay = this.identity.applyDecayPass(scope);
      if (decay.demoted + decay.retired + decay.promoted > 0) {
        this.log.log(
          `sleep: ${scope} decay pass — demoted ${decay.demoted}, retired ${decay.retired}, promoted ${decay.promoted}.`,
        );
      } else {
        this.log.log(
          `sleep: ${scope} decay pass — no changes (all rows within barren window or below promotion threshold).`,
        );
      }
    } catch (err) {
      this.log.warn(
        `sleep decay ${scope} crashed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
