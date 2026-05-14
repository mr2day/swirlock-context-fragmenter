import { Injectable, Logger } from "@nestjs/common";
import { ExperienceLessonService } from "./experience-lesson.service";
import { IdentityService } from "./identity.service";
import { RealityDriftAppealService } from "./reality-drift-appeal.service";

/**
 * The fragmenter's deep-memory pass.
 *
 * Run by `ActivityMonitorService` whenever the system has been quiet
 * (no `session.observed` in the configured quiet window). Each tick
 * does, in order:
 *   - identity merges per scope (user/app)
 *   - reinforcement-driven decay over identity rows
 *   - appeal pass over outstanding hallucinated/suspect audits
 *   - experience-lesson distillation per persona
 *   - reinforcement-driven decay over lesson rows
 *
 * Best-effort throughout — a failure in one step never aborts the
 * tick. Re-entrancy guarded by `running`.
 */
@Injectable()
export class SleepService {
  private readonly log = new Logger(SleepService.name);
  private running = false;

  constructor(
    private readonly identity: IdentityService,
    private readonly appeal: RealityDriftAppealService,
    private readonly lessons: ExperienceLessonService,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.log.log("sleep tick already running; skipping.");
      return;
    }
    this.running = true;
    this.log.log("sleep: tick started.");
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

      // Unit F — experience-lesson distillation and decay. Runs
      // after appeals so disputed audits are excluded. Distillation
      // is the LLM-driven pass; decay is pure SQL. Best-effort.
      try {
        await this.lessons.runDistillationPass();
      } catch (err) {
        this.log.warn(
          `sleep distillation pass crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        this.lessons.applyDecayPass();
      } catch (err) {
        this.log.warn(
          `sleep lesson decay pass crashed: ${
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
