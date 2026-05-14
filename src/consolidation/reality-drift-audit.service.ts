import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";
import { LlmHostService, type LlmMessage } from "../llm-host/llm-host.service";
import {
  RagEngineService,
  type SearchRunResult,
} from "../rag-engine/rag-engine.service";
import type { RealityDriftGateDecision } from "./reality-drift-gate.service";

const MAX_CLAIMS = 5;
const EVIDENCE_HIGHLIGHT_MAX_CHARS = 900;
const EXTRACT_LIMIT_PER_CLAIM = 2;

export type ClaimVerdict =
  | "verified"
  | "contradicted"
  | "partial"
  | "unverifiable";

export type TurnVerdict = "hallucinated" | "suspect" | "clean";

export interface AuditClaim {
  claim: string;
  anchorTerms: string[];
  stake: "low" | "medium" | "high";
}

export interface ClaimAudit {
  claim: string;
  anchorTerms: string[];
  stake: AuditClaim["stake"];
  searchQuery: string;
  retrievedEvidenceUrl: string | null;
  evidenceExcerpt: string;
  verdict: ClaimVerdict;
  rationale: string;
}

export interface AuditResult {
  status: "written" | "skipped" | "failed";
  auditId?: string;
  turnVerdict?: TurnVerdict;
  claims?: ClaimAudit[];
  correctedSummary?: string | null;
  reason?: string;
}

interface SessionMetaRow {
  user_id: string | null;
  persona_name: string | null;
}

interface MessageMetaRow {
  created_at: string;
}

@Injectable()
export class RealityDriftAuditService {
  private readonly log = new Logger(RealityDriftAuditService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
    private readonly rag: RagEngineService,
  ) {}

  async auditTurn(
    decision: RealityDriftGateDecision,
    assistantMessageContent: string,
  ): Promise<AuditResult> {
    if (!decision.layer2?.attempted || !decision.layer2.succeeded) {
      return { status: "skipped", reason: "layer2 not succeeded" };
    }
    if (decision.layer2.auditWorthy !== true) {
      return { status: "skipped", reason: "not audit-worthy" };
    }

    const auditCorrelationId = `cf:audit:${randomUUID()}`;
    const startedAt = Date.now();
    this.log.log(
      `[audit] start sessionId=${decision.sessionId} turnId=${decision.turnId} msgId=${decision.assistantMessageId}`,
    );

    let claims: AuditClaim[];
    try {
      claims = await this.extractClaims(
        assistantMessageContent,
        auditCorrelationId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`[audit] claim extraction failed: ${msg}`);
      return { status: "failed", reason: `claim_extraction: ${msg}` };
    }

    if (claims.length === 0) {
      this.log.log(
        `[audit] no check-worthy claims extracted; writing skip-clean audit`,
      );
      return this.persistClean(decision, assistantMessageContent, [], auditCorrelationId);
    }

    const claimAudits: ClaimAudit[] = [];
    for (const claim of claims.slice(0, MAX_CLAIMS)) {
      const searchQuery = this.buildSearchQuery(claim);
      let searchResults: SearchRunResult[] = [];
      try {
        const resp = await this.rag.searchRun({
          correlationId: `cf:audit:search:${randomUUID()}`,
          queryText: searchQuery,
          extractLimit: EXTRACT_LIMIT_PER_CLAIM,
        });
        searchResults = resp.results;
      } catch (err) {
        this.log.warn(
          `[audit] search.run failed for claim "${this.preview(claim.claim)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let adjudication: { verdict: ClaimVerdict; rationale: string };
      try {
        adjudication = await this.adjudicateClaim(
          claim,
          searchResults,
          auditCorrelationId,
        );
      } catch (err) {
        this.log.warn(
          `[audit] adjudication failed for claim "${this.preview(claim.claim)}": ${err instanceof Error ? err.message : String(err)}`,
        );
        adjudication = {
          verdict: "unverifiable",
          rationale: "adjudication call failed",
        };
      }

      const top = searchResults[0];
      claimAudits.push({
        claim: claim.claim,
        anchorTerms: claim.anchorTerms,
        stake: claim.stake,
        searchQuery,
        retrievedEvidenceUrl: top?.url ?? null,
        evidenceExcerpt: this.truncateHighlight(top?.highlight ?? ""),
        verdict: adjudication.verdict,
        rationale: adjudication.rationale,
      });
    }

    const turnVerdict = this.rollUpVerdict(claimAudits);

    let correctedSummary: string | null = null;
    if (turnVerdict !== "clean") {
      try {
        correctedSummary = await this.summarizeCorrection(
          assistantMessageContent,
          claimAudits,
          auditCorrelationId,
        );
      } catch (err) {
        this.log.warn(
          `[audit] corrected-summary generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const persisted = await this.persistAudit({
      decision,
      claimAudits,
      turnVerdict,
      correctedSummary,
      auditCorrelationId,
    });

    this.log.log(
      `[audit] done sessionId=${decision.sessionId} turnId=${decision.turnId} verdict=${turnVerdict} claims=${claimAudits.length} (${Date.now() - startedAt}ms)`,
    );

    return {
      status: "written",
      auditId: persisted.auditId,
      turnVerdict,
      claims: claimAudits,
      correctedSummary,
    };
  }

  // ---------------- claim extraction ----------------

  private async extractClaims(
    assistantMessage: string,
    auditCorrelationId: string,
  ): Promise<AuditClaim[]> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: buildClaimExtractionSystemPrompt(),
      },
      {
        role: "user",
        content: ["Assistant message to analyse:", "", assistantMessage].join(
          "\n",
        ),
      },
    ];

    const result = await this.llm.streamInfer({
      correlationId: `${auditCorrelationId}:claims`,
      messages,
      options: {
        responseFormat: "json",
        thinking: false,
        ollama: { temperature: 0.0 },
      },
    });

    return parseClaimsJson(result.text);
  }

  private buildSearchQuery(claim: AuditClaim): string {
    if (claim.anchorTerms.length > 0) {
      return claim.anchorTerms.join(" ");
    }
    return claim.claim;
  }

  // ---------------- adjudication ----------------

  private async adjudicateClaim(
    claim: AuditClaim,
    searchResults: SearchRunResult[],
    auditCorrelationId: string,
  ): Promise<{ verdict: ClaimVerdict; rationale: string }> {
    if (searchResults.length === 0) {
      return {
        verdict: "unverifiable",
        rationale: "no search results returned",
      };
    }

    const evidenceBlocks = searchResults
      .slice(0, EXTRACT_LIMIT_PER_CLAIM)
      .map(
        (r, i) =>
          `[#${i + 1}] ${r.title}\n${r.url}${
            r.publishedAt ? ` (published ${r.publishedAt})` : ""
          }\n${this.truncateHighlight(r.highlight)}`,
      )
      .join("\n\n");

    const messages: LlmMessage[] = [
      {
        role: "system",
        content: buildAdjudicationSystemPrompt(),
      },
      {
        role: "user",
        content: [
          `Claim:`,
          claim.claim,
          ``,
          `Retrieved evidence:`,
          ``,
          evidenceBlocks,
        ].join("\n"),
      },
    ];

    const result = await this.llm.streamInfer({
      correlationId: `${auditCorrelationId}:adj:${randomUUID().slice(0, 8)}`,
      messages,
      options: {
        responseFormat: "json",
        thinking: false,
        ollama: { temperature: 0.0 },
      },
    });

    const parsed = parseAdjudicationJson(result.text);
    if (!parsed) {
      return {
        verdict: "unverifiable",
        rationale: "adjudication json_parse failed",
      };
    }
    return parsed;
  }

  // ---------------- corrected summary ----------------

  private async summarizeCorrection(
    assistantMessage: string,
    claimAudits: ClaimAudit[],
    auditCorrelationId: string,
  ): Promise<string> {
    const checkedBlock = claimAudits
      .map(
        (c, i) =>
          `[${i + 1}] claim="${c.claim}" verdict=${c.verdict} evidence_url=${c.retrievedEvidenceUrl ?? "(none)"}\n    evidence="${c.evidenceExcerpt.slice(0, 300)}"\n    rationale=${c.rationale}`,
      )
      .join("\n");

    const messages: LlmMessage[] = [
      {
        role: "system",
        content: buildCorrectedSummarySystemPrompt(),
      },
      {
        role: "user",
        content: [
          `Assistant message:`,
          assistantMessage,
          ``,
          `Claim-by-claim audit:`,
          checkedBlock,
        ].join("\n"),
      },
    ];

    const result = await this.llm.streamInfer({
      correlationId: `${auditCorrelationId}:correct`,
      messages,
      options: { thinking: false, ollama: { temperature: 0.0 } },
    });

    return result.text.trim();
  }

  // ---------------- rollup + persist ----------------

  private rollUpVerdict(claims: ClaimAudit[]): TurnVerdict {
    const hasContradicted = claims.some((c) => c.verdict === "contradicted");
    if (hasContradicted) return "hallucinated";
    const unverifiableCount = claims.filter(
      (c) => c.verdict === "unverifiable",
    ).length;
    const verifiedCount = claims.filter((c) => c.verdict === "verified").length;
    if (unverifiableCount >= 2 && verifiedCount === 0) return "suspect";
    return "clean";
  }

  private async persistClean(
    decision: RealityDriftGateDecision,
    _assistantMessage: string,
    claims: ClaimAudit[],
    auditCorrelationId: string,
  ): Promise<AuditResult> {
    const persisted = await this.persistAudit({
      decision,
      claimAudits: claims,
      turnVerdict: "clean",
      correctedSummary: null,
      auditCorrelationId,
    });
    return {
      status: "written",
      auditId: persisted.auditId,
      turnVerdict: "clean",
      claims,
      correctedSummary: null,
    };
  }

  private async persistAudit(args: {
    decision: RealityDriftGateDecision;
    claimAudits: ClaimAudit[];
    turnVerdict: TurnVerdict;
    correctedSummary: string | null;
    auditCorrelationId: string;
  }): Promise<{ auditId: string }> {
    const auditId = randomUUID();
    const auditedAt = new Date().toISOString();
    const meta = this.loadSessionMeta(args.decision.sessionId);
    const msgMeta = this.loadMessageMeta(args.decision.assistantMessageId);

    const markersTriggered = JSON.stringify({
      layer1: args.decision.layer1,
      layer2: args.decision.layer2,
    });
    const claimsChecked = JSON.stringify(args.claimAudits);

    this.db.connection
      .prepare(
        `INSERT INTO fragmenter_answer_audits
           (id, session_id, turn_id, assistant_message_id, user_id, persona_name,
            occurred_at, audited_at, markers_triggered, claims_checked,
            turn_verdict, corrected_summary, appealed_at, disputed,
            fragmenter_correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
      )
      .run(
        auditId,
        args.decision.sessionId,
        args.decision.turnId,
        args.decision.assistantMessageId,
        meta?.user_id ?? null,
        meta?.persona_name ?? null,
        msgMeta?.created_at ?? auditedAt,
        auditedAt,
        markersTriggered,
        claimsChecked,
        args.turnVerdict,
        args.correctedSummary,
        args.auditCorrelationId,
      );

    return { auditId };
  }

  private loadSessionMeta(sessionId: string): SessionMetaRow | null {
    const row = this.db.connection
      .prepare(
        `SELECT user_id, persona_name FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as SessionMetaRow | undefined;
    return row ?? null;
  }

  private loadMessageMeta(messageId: string): MessageMetaRow | null {
    const row = this.db.connection
      .prepare(`SELECT created_at FROM messages WHERE id = ?`)
      .get(messageId) as MessageMetaRow | undefined;
    return row ?? null;
  }

  private truncateHighlight(highlight: string): string {
    if (highlight.length <= EVIDENCE_HIGHLIGHT_MAX_CHARS) return highlight;
    return `${highlight.slice(0, EVIDENCE_HIGHLIGHT_MAX_CHARS - 3).trimEnd()}...`;
  }

  private preview(text: string): string {
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
}

// ---------------- prompts ----------------

function buildClaimExtractionSystemPrompt(): string {
  return [
    "You are reviewing a single assistant message and extracting the highest-risk factual claims worth fact-checking against the live web.",
    "",
    "Output STRICT JSON only — no prose, no code fences. Schema:",
    '{"claims": [{"claim": <short string>, "anchor_terms": [<short strings>], "stake": "low" | "medium" | "high"}]}',
    "",
    "Rules:",
    "- Extract at most 5 claims; fewer is fine if the message has fewer specific claims.",
    "- Each claim should be a single concrete assertion about real-world people, places, organisations, events, dates, statistics, quoted statements, or relationships between named entities. Restate the claim in your own words; do not just copy a sentence.",
    "- `anchor_terms` are search-ready substrings (entity names, dates, place names) that will let a web search engine surface evidence about the claim. Prefer concrete tokens over generic vocabulary. 2–5 terms per claim is typical.",
    "- `stake` indicates how damaging it would be if the claim is wrong: high = specific name+date+action assertions, medium = generic-but-specific claims, low = broad-strokes claims.",
    "- Do NOT extract: pleasantries, opinions, self-descriptions, hedged or hypothetical statements, generic explanations, claims clearly attributed inside the message to a source the message itself names.",
    "- If the message contains NO check-worthy claims, return `{\"claims\": []}`.",
    "- Output language: write claims and anchor_terms in the same language as the assistant message.",
  ].join("\n");
}

function buildAdjudicationSystemPrompt(): string {
  return [
    "You are adjudicating a single factual claim against retrieved web evidence.",
    "",
    "Output STRICT JSON only — no prose, no code fences. Schema:",
    '{"verdict": "verified" | "contradicted" | "partial" | "unverifiable", "rationale": <short string>}',
    "",
    "Verdict definitions:",
    "- `verified`: the evidence clearly supports the claim. Specific elements (names, dates, numbers, events) match.",
    "- `contradicted`: the evidence clearly disagrees with the claim. Specific elements visibly conflict.",
    "- `partial`: some elements of the claim are supported, others are contradicted or absent.",
    "- `unverifiable`: the retrieved evidence is irrelevant, off-topic, or insufficient to support or contradict the claim. This is your honest-mode answer when the search did not surface a real check.",
    "",
    "Rules:",
    "- Be honest. If the evidence is weak or irrelevant, say `unverifiable` — do not fabricate support.",
    "- `rationale` is one sentence (≤ 25 words) explaining the verdict.",
    "- Answer in English regardless of the claim or evidence language.",
  ].join("\n");
}

function buildCorrectedSummarySystemPrompt(): string {
  return [
    "You are writing a short forensic record of an assistant message that failed a hallucination audit.",
    "",
    "Output plain prose, no JSON, no code fences. Length: 1–3 sentences, max ~60 words.",
    "",
    "Shape: `I claimed X. Reality says Y.` Concrete and specific. If the audit produced multiple verdicts, focus on the contradicted ones first, then unverifiables. Do not editorialise; do not apologise; do not write meta-commentary about hallucinating.",
    "Answer in English.",
  ].join("\n");
}

// ---------------- JSON parsers ----------------

function parseClaimsJson(raw: string): AuditClaim[] {
  const stripped = stripCodeFences(raw).trim();
  if (!stripped) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const obj = parsed as Record<string, unknown>;
  const arr = Array.isArray(obj.claims) ? obj.claims : [];
  const out: AuditClaim[] = [];
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const claim = typeof e.claim === "string" ? e.claim.trim() : "";
    if (!claim) continue;
    const anchorTermsRaw = Array.isArray(e.anchor_terms) ? e.anchor_terms : [];
    const anchorTerms = anchorTermsRaw
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);
    const stake =
      e.stake === "low" || e.stake === "medium" || e.stake === "high"
        ? e.stake
        : "medium";
    out.push({ claim, anchorTerms, stake });
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

function parseAdjudicationJson(
  raw: string,
): { verdict: ClaimVerdict; rationale: string } | null {
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
  const verdict = obj.verdict;
  if (
    verdict !== "verified" &&
    verdict !== "contradicted" &&
    verdict !== "partial" &&
    verdict !== "unverifiable"
  ) {
    return null;
  }
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  return { verdict, rationale };
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}
