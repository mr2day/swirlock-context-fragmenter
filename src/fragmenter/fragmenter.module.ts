import { Module } from "@nestjs/common";
import { ConsolidationModule } from "../consolidation/consolidation.module";
import { FragmenterStreamHandler } from "./fragmenter-stream.handler";

@Module({
  imports: [ConsolidationModule],
  providers: [FragmenterStreamHandler],
  exports: [FragmenterStreamHandler],
})
export class FragmenterModule {}
