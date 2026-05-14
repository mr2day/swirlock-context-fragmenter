import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { DatabaseService } from "../database/database.service";
import { LlmHostService } from "../llm-host/llm-host.service";

export interface RealityDriftGateLayer1 {
  /** Did the orchestrator run SEARCH on this turn? If yes, the gate skips. */
  searchRan: boolean;
  /** Character length of the assistant message. */
  lengthChars: number;
  /** Year-like tokens (19xx, 20xx, or Arabic-Indic equivalent) found. */
  yearTokens: number;
  /** Digit-adjacent-short-word tokens found (any Unicode letter class). */
  digitWordTokens: number;
  /** Quoted substrings in paragraphs without a URL. */
  quotedSubstrings: number;
  /** True if all three Layer-1 conditions hold and the turn proceeds to Layer 2. */
  passed: boolean;
  /** Short string describing which conditions failed when passed is false. */
  skippedReason?: string;
}

export interface RealityDriftGateLayer2 {
  attempted: boolean;
  succeeded: boolean;
  durationMs: number;
  auditWorthy?: boolean;
  hallucinationRisk?: number;
  why?: string;
  rawPreview?: string;
  error?: string;
}

export interface RealityDriftGateDecision {
  sessionId: string;
  turnId: string;
  assistantMessageId: string;
  layer1: RealityDriftGateLayer1;
  layer2?: RealityDriftGateLayer2;
}

interface AssistantMessageRow {
  id: string;
  turn_id: string;
  seq: number;
  content: string;
}

/**
 * Unit C — reality-drift gate, log-only mode.
 *
 * Runs after each session.summary refresh. For the most recent
 * assistant message on that session:
 *   1. Cheap structural pre-filter (Layer 1): no SEARCH, length and
 *      specifics-density above thresholds.
 *   2. If Layer 1 passes, a single Utility-LLM call asks for a
 *      STRICT-JSON audit_worthy / hallucination_risk verdict.
 *
 * In log-only mode the decisions go to the Nest logger only — no
 * audit table is written, no search calls are made, no downstream
 * code depends on the verdicts. The purpose is to observe Layer-1
 * + Layer-2 behaviour on real traffic and tune thresholds + prompt
 * before Unit D wires audits into a storage path.
 */
@Injectable()
export class RealityDriftGateService {
  private readonly log = new Logger(RealityDriftGateService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
  ) {}

  /**
   * Evaluate the gate for the most recent assistant message in this
   * session. Best-effort: any failure is logged and silently
   * suppressed (gate must never break the scheduler).
   */
  async evaluateLatestTurn(
    sessionId: string,
  ): Promise<RealityDriftGateDecision | null> {
    const msg = this.loadLatestAssistantMessage(sessionId);
    if (!msg) {
      this.log.log(
        `[gate] sessionId=${sessionId} skipped (no assistant message)`,
      );
      return null;
    }

    const searchRan = this.didSearchRun(msg.turn_id);
    const layer1 = this.runLayer1(msg.content, searchRan);

    this.log.log(
      `[gate:l1] sessionId=${sessionId} turnId=${msg.turn_id} seq=${msg.seq} ` +
        `len=${layer1.lengthChars} years=${layer1.yearTokens} ` +
        `digitWords=${layer1.digitWordTokens} quotes=${layer1.quotedSubstrings} ` +
        `searchRan=${searchRan} decision=${layer1.passed ? "pass" : "skip"}` +
        (layer1.passed ? "" : ` (${layer1.skippedReason})`),
    );

    if (!layer1.passed) {
      return {
        sessionId,
        turnId: msg.turn_id,
        assistantMessageId: msg.id,
        layer1,
      };
    }

    const layer2 = await this.runLayer2(msg.content);

    if (layer2.attempted && layer2.succeeded) {
      this.log.log(
        `[gate:l2] sessionId=${sessionId} turnId=${msg.turn_id} ` +
          `audit_worthy=${layer2.auditWorthy} risk=${layer2.hallucinationRisk} ` +
          `(${Math.round(layer2.durationMs)}ms) why="${(layer2.why ?? "").replace(/"/g, "'")}"`,
      );
    } else {
      this.log.warn(
        `[gate:l2] sessionId=${sessionId} turnId=${msg.turn_id} ` +
          `failed (${layer2.error ?? "unknown"}); raw preview: ${layer2.rawPreview ?? "(none)"}`,
      );
    }

    return {
      sessionId,
      turnId: msg.turn_id,
      assistantMessageId: msg.id,
      layer1,
      layer2,
    };
  }

  // ------- Layer 1 -------

  private runLayer1(
    content: string,
    searchRan: boolean,
  ): RealityDriftGateLayer1 {
    const cfg = this.cfg.consolidation.realityDriftGate;
    const lengthChars = content.length;
    const yearTokens = countYearTokens(content);
    const digitWordTokens = countDigitWordTokens(content);
    const quotedSubstrings = countQuotesOutsideUrlParagraphs(content);

    const per1k = (n: number): number => (lengthChars > 0 ? (n * 1000) / lengthChars : 0);
    const densityHits: string[] = [];
    if (per1k(yearTokens) >= cfg.yearTokensPer1kChars) densityHits.push("years");
    if (per1k(digitWordTokens) >= cfg.digitWordTokensPer1kChars)
      densityHits.push("digitWords");
    if (per1k(quotedSubstrings) >= cfg.quotedSubstringsPer1kChars)
      densityHits.push("quotes");

    const reasons: string[] = [];
    if (searchRan) reasons.push("searchRan");
    if (lengthChars < cfg.minChars) reasons.push("tooShort");
    if (densityHits.length === 0) reasons.push("lowDensity");

    return {
      searchRan,
      lengthChars,
      yearTokens,
      digitWordTokens,
      quotedSubstrings,
      passed: reasons.length === 0,
      ...(reasons.length > 0 ? { skippedReason: reasons.join(",") } : {}),
    };
  }

  // ------- Layer 2 -------

  private async runLayer2(content: string): Promise<RealityDriftGateLayer2> {
    const startedAt = Date.now();
    const correlationId = `cf:gate:${randomUUID()}`;
    const messages = buildGatePromptMessages(content);

    try {
      const result = await this.llm.streamInfer({
        correlationId,
        messages,
        options: {
          responseFormat: "json",
          thinking: false,
          ollama: { temperature: 0.0 },
        },
      });
      const durationMs = Date.now() - startedAt;
      const parsed = parseGateJson(result.text);
      if (!parsed) {
        return {
          attempted: true,
          succeeded: false,
          durationMs,
          rawPreview: result.text.replace(/\s+/g, " ").slice(0, 240),
          error: "json_parse",
        };
      }
      return {
        attempted: true,
        succeeded: true,
        durationMs,
        auditWorthy: parsed.audit_worthy,
        hallucinationRisk: parsed.hallucination_risk,
        why: parsed.why,
      };
    } catch (err) {
      return {
        attempted: true,
        succeeded: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ------- DB helpers -------

  private loadLatestAssistantMessage(
    sessionId: string,
  ): AssistantMessageRow | null {
    const row = this.db.connection
      .prepare(
        `SELECT id, turn_id, seq, content
           FROM messages
          WHERE session_id = ? AND role = 'assistant'
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(sessionId) as AssistantMessageRow | undefined;
    return row ?? null;
  }

  private didSearchRun(turnId: string): boolean {
    try {
      const row = this.db.connection
        .prepare(
          `SELECT 1
             FROM decision_events
            WHERE turn_id = ?
              AND event_type LIKE 'command.SEARCH.%'
            LIMIT 1`,
        )
        .get(turnId);
      return Boolean(row);
    } catch {
      // decision_events table absent (fresh DB, no turns yet). The
      // gate's "no SEARCH ran" condition is the safest default —
      // bias toward auditing.
      return false;
    }
  }
}

// ---------------- pure helpers (testable, language-agnostic) ----------------

// Year-like tokens: 19xx / 20xx (ASCII digits) plus the same shape
// over Arabic-Indic digits. Tight pattern — covers the vast majority
// of real-world year mentions across languages.
const ASCII_YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const ARABIC_INDIC_YEAR_RE = /[٠-٩]{4}/g;

function countYearTokens(text: string): number {
  return (
    (text.match(ASCII_YEAR_RE)?.length ?? 0) +
    (text.match(ARABIC_INDIC_YEAR_RE)?.length ?? 0)
  );
}

// Digit-adjacent short-word tokens: shapes like "5 km", "1947 a", "200kg".
// Unicode letter class via the /u flag — picks up Latin, Cyrillic,
// Greek, Armenian, Georgian, Korean, etc. without per-language
// stopword lists.
const DIGIT_WORD_RE = /\d+\s?[\p{L}]{1,6}\b/gu;

function countDigitWordTokens(text: string): number {
  return text.match(DIGIT_WORD_RE)?.length ?? 0;
}

// Quoted substrings: counted only in paragraphs that don't contain a
// URL. The presence of a URL in the same paragraph is a proxy for
// "the quote is attributed to a citable source"; absence is a proxy
// for "the bot is putting words in someone's mouth without a source".
const URL_RE = /https?:\/\//i;
const QUOTE_PATTERNS: RegExp[] = [
  /"[^"\n]+"/g,
  /'[^'\n]+'/g,
  /“[^”\n]+”/g, // “ … ”
  /‘[^’\n]+’/g, // ‘ … ’
  /«[^»\n]+»/g, // « … »
  /‹[^›\n]+›/g, // ‹ … ›
  /„[^“”\n]+[“”]/g, // „ … " / „ … "
  /『[^』\n]+』/g, // 『 … 』
  /「[^」\n]+」/g, // 「 … 」
];

function countQuotesOutsideUrlParagraphs(text: string): number {
  const paragraphs = text.split(/\n\s*\n+/);
  let total = 0;
  for (const para of paragraphs) {
    if (URL_RE.test(para)) continue;
    for (const re of QUOTE_PATTERNS) {
      total += para.match(re)?.length ?? 0;
    }
  }
  return total;
}

// ---------------- Layer 2 prompt + parser ----------------

interface GateJson {
  audit_worthy: boolean;
  hallucination_risk: number;
  why: string;
}

function buildGatePromptMessages(
  message: string,
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "You are reviewing a single message the assistant produced in a chat. Decide whether the message is worth auditing for hallucinations.",
    "",
    "Output STRICT JSON only — no prose, no code fences. Schema:",
    '{"audit_worthy": <boolean>, "hallucination_risk": <integer 0..10>, "why": <short string>}',
    "",
    "Rules:",
    '- Mark `audit_worthy: true` only when the message makes specific factual claims about real-world people, places, organisations, events, dates, statistics, quoted statements, or relationships between named entities — AND those claims are NOT visibly grounded in sources cited inside the message itself.',
    "- Conversational pleasantries, opinions, self-descriptions, generic explanations, and clearly hypothetical statements are NOT audit-worthy.",
    '- If the assistant itself signals uncertainty about any claim — phrases of the shape "I\'m not sure", "I might be wrong", "I think", or any equivalent in any language — set `audit_worthy: true` regardless of the other criteria.',
    "- `hallucination_risk` is your 0-10 estimate of how risky the unsourced specific claims are: 0 = no risk, 10 = looks fabricated.",
    "- `why` is a one-sentence reason; keep it under 25 words.",
    "- Be conservative — false positives just waste audit budget, false negatives let bad memories form silently. Lean toward `audit_worthy: true` on borderline cases.",
    "- The underlying message may be in any language. Answer in English.",
  ].join("\n");

  const user = ["Message to review:", "", message].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseGateJson(raw: string): GateJson | null {
  const stripped = stripCodeFences(raw).trim();
  if (!stripped) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const auditWorthy =
    typeof obj.audit_worthy === "boolean" ? obj.audit_worthy : null;
  const riskRaw =
    typeof obj.hallucination_risk === "number"
      ? obj.hallucination_risk
      : typeof obj.hallucination_risk === "string"
        ? Number.parseFloat(obj.hallucination_risk)
        : null;
  const why = typeof obj.why === "string" ? obj.why : null;
  if (auditWorthy === null || riskRaw === null || why === null) return null;
  const risk = Math.max(0, Math.min(10, Math.round(riskRaw)));
  return { audit_worthy: auditWorthy, hallucination_risk: risk, why };
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}
