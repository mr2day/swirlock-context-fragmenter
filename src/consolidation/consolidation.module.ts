import { Module } from "@nestjs/common";
import { LlmHostModule } from "../llm-host/llm-host.module";
import { RagEngineModule } from "../rag-engine/rag-engine.module";
import { ActivityMonitorService } from "./activity-monitor.service";
import { BackfillCrawlerService } from "./backfill-crawler.service";
import { ConsolidationScheduler } from "./consolidation-scheduler.service";
import { ExperienceLessonService } from "./experience-lesson.service";
import { HallucinationIndexService } from "./hallucination-index.service";
import { IdentityService } from "./identity.service";
import { RealityDriftAppealService } from "./reality-drift-appeal.service";
import { RealityDriftAuditService } from "./reality-drift-audit.service";
import { SessionSummaryService } from "./session-summary.service";
import { SleepService } from "./sleep.service";

@Module({
  imports: [LlmHostModule, RagEngineModule],
  providers: [
    SessionSummaryService,
    IdentityService,
    RealityDriftAuditService,
    RealityDriftAppealService,
    ExperienceLessonService,
    HallucinationIndexService,
    ConsolidationScheduler,
    BackfillCrawlerService,
    SleepService,
    ActivityMonitorService,
  ],
  exports: [ConsolidationScheduler],
})
export class ConsolidationModule {}
