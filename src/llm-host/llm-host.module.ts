import { Module } from "@nestjs/common";
import { LlmHostService } from "./llm-host.service";

@Module({
  providers: [LlmHostService],
  exports: [LlmHostService],
})
export class LlmHostModule {}
