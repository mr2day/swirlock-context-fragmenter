import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { ConsolidationModule } from "./consolidation/consolidation.module";
import { DatabaseModule } from "./database/database.module";
import { FragmenterModule } from "./fragmenter/fragmenter.module";
import { LlmHostModule } from "./llm-host/llm-host.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    LlmHostModule,
    ConsolidationModule,
    FragmenterModule,
  ],
})
export class AppModule {}
