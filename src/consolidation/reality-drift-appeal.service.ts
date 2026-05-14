import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";
import { LlmHostService, type LlmMessage } from "../llm-host/llm-host.service";
import {
  RagEngineService,
  type SearchRunResult,
} from "../rag-engine/rag-engine.service";
import type {
  ClaimAudit,
  ClaimVerdict,
  TurnVerdict,
} from "./reality-drift-audit.service";

const EXTRACT_LIMIT_PER_APPEAL = 2;

interface OutstandingAuditRow {
  id: string;
  session_id: string;
  turn_id: string;
  claims_checked: string;
  turn_verdict: TurnVerdict;
}

export interface AppealSummary {
  scanned: number;
  appealed: number;
  disputed: number;
  failed: number;
}

/**
 * Unit E — automated appeal pass over `hallucinated` / `suspect`
 * audits. Runs at sleep cadence. Each audit is appealed at most
 * once (guarded by `appealed_at IS NULL`).
 *
 * For each "problem" claim (verdict in {contradicted, unverifiable})
 * the appeal:
 *   1. Asks the LLM to produce a single adversarial search query
 *      oriented toward surfacing evidence that the claim was
 *      actually supportable.
 *   2. Runs `search.run` with that query.
 *   3. Re-adjudicates the claim under adversarial framing: "if any
 *      reasonable case for support exists, output the new verdict;
 *      otherwise concede the original."
 *
 * Verified / partial claims are left untouched — they were not the
 * reason the audit was flagged.
 *
 * After re-adjudication the original rollup is re-applied with the
 * updated per-claim verdicts. If the new rollup is `clean`, the
 * appeal contradicts the original audit and `disputed` is set to
 * 1; otherwise the audit stands. `appealed_at` is always set on
 * the row so the audit is never appealed twice.
 */
@Injectable()
export class RealityDriftAppealService {
  private readonly log = new Logger(RealityDriftAppealService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
    private readonly rag: RagEngineService,
  ) {}

  async runOutstandingAppeals(): Promise<AppealSummary> {
    const rows = this.loadOutstandingAudits();
    const summary: AppealSummary = {
      scanned: rows.length,
      appealed: 0,
      disputed: 0,
      failed: 0,
    };
    if (rows.length === 0) {
      this.log.log("appeal: no outstanding audits to appeal.");
      return summary;
    }
    this.log.log(
      `appeal: ${rows.length} outstanding audit(s) (hallucinated|suspect, not yet appealed).`,
    );

    for (const row of rows) {
      try {
        const result = await this.appealAudit(row);
        summary.appealed += 1;
        if (result.disputed) summary.disputed += 1;
      } catch (err) {
        summary.failed += 1;
        this.log.warn(
          `appeal: audit ${row.id} crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.log.log(
      `appeal: done — appealed ${summary.appealed}, disputed ${summary.disputed}, failed ${summary.failed}.`,
    );
    return summary;
  }

  private async appealAudit(
    row: OutstandingAuditRow,
  ): Promise<{ disputed: boolean }> {
    const appealCorrelationId = `cf:appeal:${randomUUID()}`;
    const originalClaims = this.parseClaims(row.claims_checked);
    if (originalClaims.length === 0) {
      this.markAppealed(row.id, false);
      return { disputed: false };
    }

    const updatedClaims: ClaimAudit[] = [];
    for (const claim of originalClaims) {
      if (claim.verdict === "verified" || claim.verdict === "partial") {
        updatedClaims.push(claim);
        continue;
      }
      try {
        const rev = await this.reAdjudicateClaim(claim, appealCorrelationId);
        updatedClaims.push(rev);
      } catch (err) {
        this.log.warn(
          `appeal: re-adjudication crashed for audit ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        updatedClaims.push(claim);
      }
    }

    const newVerdict = this.rollUpVerdict(updatedClaims);
    const disputed = newVerdict !== row.turn_verdict && newVerdict === "clean";

    this.log.log(
      `appeal: audit ${row.id} originalVerdict=${row.turn_verdict} newRollup=${newVerdict} disputed=${disputed}`,
    );

    this.persistAppeal(row.id, updatedClaims, disputed);
    return { disputed };
  }

  private async reAdjudicateClaim(
    claim: ClaimAudit,
    appealCorrelationId: string,
  ): Promise<ClaimAudit> {
    const adversarialQuery = await this.generateAdversarialQuery(
      claim,
      appealCorrelationId,
    );

    let searchResults: SearchRunResult[] = [];
    try {
      const resp = await this.rag.searchRun({
        correlationId: `${appealCorrelationId}:search:${randomUUID().slice(0, 8)}`,
        queryText: adversarialQuery,
        extractLimit: EXTRACT_LIMIT_PER_APPEAL,
      });
      searchResults = resp.results;
    } catch (err) {
      this.log.warn(
        `appeal: search.run failed for adversarial query "${this.preview(adversarialQuery)}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (searchResults.length === 0) {
      return {
        ...claim,
        searchQuery: adversarialQuery,
        retrievedEvidenceUrl: null,
        evidenceExcerpt: "",
        verdict: claim.verdict,
        rationale: `appeal: no adversarial evidence surfaced (${claim.rationale})`,
      };
    }

    const adjudication = await this.adversarialAdjudicate(
      claim,
      searchResults,
      appealCorrelationId,
    );

    const top = searchResults[0];
    return {
      claim: claim.claim,
      anchorTerms: claim.anchorTerms,
      stake: claim.stake,
      searchQuery: adversarialQuery,
      retrievedEvidenceUrl: top?.url ?? null,
      evidenceExcerpt: this.truncateHighlight(top?.highlight ?? ""),
      verdict: adjudication.verdict,
      rationale: `appeal: ${adjudication.rationale}`,
    };
  }

  private async generateAdversarialQuery(
    claim: ClaimAudit,
    appealCorrelationId: string,
  ): Promise<string> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: buildAdversarialQuerySystemPrompt(),
      },
      {
        role: "user",
        content: [
          `Claim under appeal (originally verdict=${claim.verdict}):`,
          claim.claim,
          ``,
          `Original anchor terms: ${claim.anchorTerms.join(" | ")}`,
          `Original search query: ${claim.searchQuery}`,
          `Original rationale: ${claim.rationale}`,
        ].join("\n"),
      },
    ];

    const result = await this.llm.streamInfer({
      correlationId: `${appealCorrelationId}:q:${randomUUID().slice(0, 8)}`,
      messages,
      options: {
        responseFormat: "json",
        thinking: false,
        ollama: { temperature: 0.0 },
      },
    });

    const parsed = parseAdversarialQueryJson(result.text);
    if (!parsed) {
      return `evidence supporting "${claim.claim}"`;
    }
    return parsed;
  }

  private async adversarialAdjudicate(
    claim: ClaimAudit,
    results: SearchRunResult[],
    appealCorrelationId: string,
  ): Promise<{ verdict: ClaimVerdict; rationale: string }> {
    const evidenceBlocks = results
      .slice(0, EXTRACT_LIMIT_PER_APPEAL)
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
        content: buildAdversarialAdjudicationSystemPrompt(),
      },
      {
        role: "user",
        content: [
          `Claim under appeal (originally judged ${claim.verdict}):`,
          claim.claim,
          ``,
          `Original adjudication rationale: ${claim.rationale}`,
          ``,
          `Fresh evidence from adversarial search:`,
          ``,
          evidenceBlocks,
        ].join("\n"),
      },
    ];

    const result = await this.llm.streamInfer({
      correlationId: `${appealCorrelationId}:adj:${randomUUID().slice(0, 8)}`,
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
        verdict: claim.verdict,
        rationale: "adversarial adjudication json_parse failed",
      };
    }
    return parsed;
  }

  // ---------------- rollup + persistence ----------------

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

  private loadOutstandingAudits(): OutstandingAuditRow[] {
    return this.db.connection
      .prepare(
        `SELECT id, session_id, turn_id, claims_checked, turn_verdict
           FROM fragmenter_answer_audits
          WHERE turn_verdict IN ('hallucinated', 'suspect')
            AND appealed_at IS NULL
            AND disputed = 0
          ORDER BY audited_at ASC`,
      )
      .all() as OutstandingAuditRow[];
  }

  private markAppealed(auditId: string, disputed: boolean): void {
    this.db.connection
      .prepare(
        `UPDATE fragmenter_answer_audits
            SET appealed_at = ?, disputed = ?
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), disputed ? 1 : 0, auditId);
  }

  private persistAppeal(
    auditId: string,
    updatedClaims: ClaimAudit[],
    disputed: boolean,
  ): void {
    this.db.connection
      .prepare(
        `UPDATE fragmenter_answer_audits
            SET appealed_at = ?, disputed = ?, claims_checked = ?
          WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        disputed ? 1 : 0,
        JSON.stringify(updatedClaims),
        auditId,
      );
  }

  private parseClaims(raw: string): ClaimAudit[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (c): c is ClaimAudit =>
          typeof c === "object" && c !== null && typeof (c as ClaimAudit).claim === "string",
      );
    } catch {
      return [];
    }
  }

  private truncateHighlight(highlight: string): string {
    const max = 900;
    if (highlight.length <= max) return highlight;
    return `${highlight.slice(0, max - 3).trimEnd()}...`;
  }

  private preview(text: string): string {
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  }
}

// ---------------- prompts ----------------

function buildAdversarialQuerySystemPrompt(): string {
  return [
    "You are generating a fresh web-search query for an appeal pass over an assistant hallucination audit. The original audit flagged the claim below as unsupported. Your job is to generate ONE query that would surface evidence the claim IS actually supportable — counter-evidence to the original audit.",
    "",
    "Output STRICT JSON only — no prose, no code fences. Schema:",
    '{"query": <short string>}',
    "",
    "Rules:",
    "- The query MUST differ from the original anchor terms in approach: try alternative spellings, broader entity context, related-but-different phrasings, or affirmative restatements that lean toward finding support for the claim.",
    "- The query should NOT be a verbatim re-arrangement of the original anchor terms.",
    "- Keep it under 25 words.",
    "- Write the query in the same language as the claim itself.",
  ].join("\n");
}

function buildAdversarialAdjudicationSystemPrompt(): string {
  return [
    "You are providing a second-opinion adjudication on a single claim that an earlier audit flagged as `contradicted` or `unverifiable`. Be deliberately willing to disagree with the earlier audit if the fresh evidence supports the claim.",
    "",
    "Output STRICT JSON only — no prose, no code fences. Schema:",
    '{"verdict": "verified" | "contradicted" | "partial" | "unverifiable", "rationale": <short string>}',
    "",
    "Verdict definitions:",
    "- `verified`: the fresh evidence supports the claim. Even if the original audit said otherwise, you may flip to verified.",
    "- `contradicted`: the fresh evidence still clearly disagrees with the claim. Concede the original verdict.",
    "- `partial`: some elements supported, others not.",
    "- `unverifiable`: the fresh evidence is irrelevant or insufficient — the original audit's caution stands.",
    "",
    "Rules:",
    "- Be honest. The appeal exists to catch wrong audits, not to rubber-stamp them. If fresh evidence supports the claim, say so. If it doesn't, concede.",
    "- `rationale` is one sentence (≤ 25 words) explaining the verdict.",
    "- Answer in English regardless of the claim or evidence language.",
  ].join("\n");
}

// ---------------- JSON parsers ----------------

function parseAdversarialQueryJson(raw: string): string | null {
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
  const query = typeof obj.query === "string" ? obj.query.trim() : "";
  return query.length > 0 ? query : null;
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
