import * as path from "path";

export interface DatabaseConfig {
  /** Absolute path to the shared SQLite file (orchestrator owns the schema for live tables). */
  file: string;
}

export interface LlmHostConfig {
  baseUrl: string;
  callerService: string;
  timeoutMs: number;
}

export interface ConsolidationConfig {
  sessionSummaryMinNewTurns: number;
  sessionSummaryMaxRecentMessages: number;
  maxQueueDepth: number;
}

export interface ServiceConfig {
  serviceName: string;
  host: string;
  port: number;
  bearerToken: string;
  database: DatabaseConfig;
  llmHost: LlmHostConfig;
  consolidation: ConsolidationConfig;
}

export const SERVICE_CONFIG = Symbol("SERVICE_CONFIG");

export function loadServiceConfig(): ServiceConfig {
  const cfgPath = path.resolve(process.cwd(), "service.config.cjs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(cfgPath) as { env?: ServiceConfig };
  if (!mod?.env) {
    throw new Error(`service.config.cjs at ${cfgPath} must export { env }`);
  }
  validate(mod.env);
  return mod.env;
}

function validate(c: ServiceConfig): void {
  const must = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`service.config.cjs invalid: ${msg}`);
  };
  must(c.serviceName, "serviceName required");
  must(c.host, "host required");
  must(typeof c.port === "number" && c.port > 0, "port required");
  must(
    typeof c.bearerToken === "string" && c.bearerToken.length > 0,
    "bearerToken required",
  );
  must(c.database?.file, "database.file required");
  must(c.llmHost?.baseUrl, "llmHost.baseUrl required");
  must(c.llmHost?.callerService, "llmHost.callerService required");
  must(typeof c.llmHost?.timeoutMs === "number", "llmHost.timeoutMs required");
  must(
    Number.isInteger(c.consolidation?.sessionSummaryMinNewTurns) &&
      c.consolidation.sessionSummaryMinNewTurns > 0,
    "consolidation.sessionSummaryMinNewTurns must be a positive integer",
  );
  must(
    Number.isInteger(c.consolidation?.sessionSummaryMaxRecentMessages) &&
      c.consolidation.sessionSummaryMaxRecentMessages > 0,
    "consolidation.sessionSummaryMaxRecentMessages must be a positive integer",
  );
  must(
    Number.isInteger(c.consolidation?.maxQueueDepth) &&
      c.consolidation.maxQueueDepth > 0,
    "consolidation.maxQueueDepth must be a positive integer",
  );
}
