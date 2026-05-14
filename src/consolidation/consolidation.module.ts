import { Module } from "@nestjs/common";
import { LlmHostModule } from "../llm-host/llm-host.module";
import { BackfillCrawlerService } from "./backfill-crawler.service";
import { ConsolidationScheduler } from "./consolidation-scheduler.service";
import { SessionSummaryService } from "./session-summary.service";

@Module({
  imports: [LlmHostModule],
  providers: [
    SessionSummaryService,
    ConsolidationScheduler,
    BackfillCrawlerService,
  ],
  exports: [ConsolidationScheduler],
})
export class ConsolidationModule {}
