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

export interface RagEngineConfig {
  baseUrl: string;
  callerService: string;
  timeoutMs: number;
}

export interface ConsolidationConfig {
  sessionSummaryMinNewTurns: number;
  sessionSummaryMaxRecentMessages: number;
  maxQueueDepth: number;
  /**
   * How long (ms) the fragmenter must observe no `session.observed`
   * activity before flipping to "sleeping" mode and running a sleep
   * tick. Sleep runs at most once per quiet window; the next tick
   * fires only after a fresh active→sleeping transition.
   */
  quietThresholdMs: number;
  /**
   * How many consecutive sleep-tick durations a fact may go without
   * reinforcement before being decayed. Demotes `core` -> `important`,
   * `important` -> `incidental`. An `incidental` row that hits this
   * threshold is retired (superseded_at set).
   *
   * Default 336 = roughly 7 days at the default 30-min sleep cadence.
   */
  decayBarrenTicks: number;
  /**
   * How many reinforcements a row needs to be promoted one tier.
   * `incidental` -> `important` requires this many; `important` ->
   * `core` requires twice this many.
   */
  promotionReinforcementThreshold: number;
  /**
   * Unit C: thresholds for the reality-drift Layer-1 structural
   * pre-filter. A turn is candidate for the Layer-2 LLM gate only
   * when (no SEARCH ran this turn) AND (length >= minChars) AND
   * (at least one of the specifics-density counters is above its
   * per-1000-char floor).
   */
  realityDriftGate: {
    /** Minimum length of the assistant message in characters. */
    minChars: number;
    /** Year-like tokens (19xx, 20xx, or Arabic-Indic equivalent) per 1000 chars. */
    yearTokensPer1kChars: number;
    /** Digit-adjacent-short-word tokens per 1000 chars. */
    digitWordTokensPer1kChars: number;
    /** Quoted substrings in paragraphs without a URL, per 1000 chars. */
    quotedSubstringsPer1kChars: number;
  };
}

export interface ServiceConfig {
  serviceName: string;
  host: string;
  port: number;
  bearerToken: string;
  database: DatabaseConfig;
  llmHost: LlmHostConfig;
  ragEngine: RagEngineConfig;
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
  must(c.ragEngine?.baseUrl, "ragEngine.baseUrl required");
  must(c.ragEngine?.callerService, "ragEngine.callerService required");
  must(
    typeof c.ragEngine?.timeoutMs === "number",
    "ragEngine.timeoutMs required",
  );
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
  must(
    Number.isInteger(c.consolidation?.quietThresholdMs) &&
      c.consolidation.quietThresholdMs > 0,
    "consolidation.quietThresholdMs must be a positive integer",
  );
  must(
    Number.isInteger(c.consolidation?.decayBarrenTicks) &&
      c.consolidation.decayBarrenTicks > 0,
    "consolidation.decayBarrenTicks must be a positive integer",
  );
  must(
    Number.isInteger(c.consolidation?.promotionReinforcementThreshold) &&
      c.consolidation.promotionReinforcementThreshold > 0,
    "consolidation.promotionReinforcementThreshold must be a positive integer",
  );
  const gate = c.consolidation?.realityDriftGate;
  must(gate, "consolidation.realityDriftGate required");
  must(
    Number.isInteger(gate?.minChars) && (gate?.minChars ?? 0) > 0,
    "consolidation.realityDriftGate.minChars must be a positive integer",
  );
  must(
    typeof gate?.yearTokensPer1kChars === "number" &&
      (gate?.yearTokensPer1kChars ?? -1) >= 0,
    "consolidation.realityDriftGate.yearTokensPer1kChars must be a non-negative number",
  );
  must(
    typeof gate?.digitWordTokensPer1kChars === "number" &&
      (gate?.digitWordTokensPer1kChars ?? -1) >= 0,
    "consolidation.realityDriftGate.digitWordTokensPer1kChars must be a non-negative number",
  );
  must(
    typeof gate?.quotedSubstringsPer1kChars === "number" &&
      (gate?.quotedSubstringsPer1kChars ?? -1) >= 0,
    "consolidation.realityDriftGate.quotedSubstringsPer1kChars must be a non-negative number",
  );
}
