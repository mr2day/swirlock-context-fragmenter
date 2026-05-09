import { Global, Module } from "@nestjs/common";
import { loadServiceConfig, SERVICE_CONFIG } from "./config";

@Global()
@Module({
  providers: [
    {
      provide: SERVICE_CONFIG,
      useFactory: () => loadServiceConfig(),
    },
  ],
  exports: [SERVICE_CONFIG],
})
export class ConfigModule {}
