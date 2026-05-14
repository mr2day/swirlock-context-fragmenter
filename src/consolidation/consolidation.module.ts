import { Module } from "@nestjs/common";
import { LlmHostModule } from "../llm-host/llm-host.module";
import { BackfillCrawlerService } from "./backfill-crawler.service";
import { ConsolidationScheduler } from "./consolidation-scheduler.service";
import { IdentityService } from "./identity.service";
import { SessionSummaryService } from "./session-summary.service";
import { SleepService } from "./sleep.service";

@Module({
  imports: [LlmHostModule],
  providers: [
    SessionSummaryService,
    IdentityService,
    ConsolidationScheduler,
    BackfillCrawlerService,
    SleepService,
  ],
  exports: [ConsolidationScheduler],
})
export class ConsolidationModule {}
