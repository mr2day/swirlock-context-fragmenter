import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  RealityDriftAuditService,
  type ClaimAudit,
} from "./reality-drift-audit.service";
import { measureSpecifics } from "./structural-specifics";

const TRIVIAL_LENGTH_CHARS = 200;

interface AssistantMessageRow {
  id: string;
  turn_id: string;
  seq: number;
  content: string;
  hallucination_index: number | null;
}

export interface HallucinationIndexResult {
  status: "indexed" | "skipped" | "failed";
  hallucinationIndex?: number;
  auditWritten?: boolean;
  reason?: string;
}

/**
 * Per-turn hallucination indexing.
 *
 * Invoked from the scheduler on every `session.observed` event,
 * fire-and-forget. For the latest assistant message in the session
 * whose `messages.hallucination_index` is still NULL:
 *
 *   1. Cheap structural pre-check (length + specifics density).
 *      Trivial replies — short text with no year tokens, no
 *      digit+word tokens, no unsourced quotes — get index = 0 with
 *      no LLM or search calls, and no `fragmenter_answer_audits`
 *      row.
 *   2. Otherwise the audit pipeline runs (claim extraction → per-claim
 *      `search.run` → adjudication → roll-up). The pipeline writes
 *      `fragmenter_answer_audits` and returns the per-claim verdicts.
 *   3. The 0–10 index is derived from the verdicts (verified=0,
 *      partial=3, unverifiable=5, contradicted=10; averaged and
 *      rounded) and written to `messages.hallucination_index`.
 *
 * If claim extraction returns zero claims, the message has nothing
 * factual to check — index = 0, no audit row.
 */
@Injectable()
export class HallucinationIndexService {
  private readonly log = new Logger(HallucinationIndexService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: RealityDriftAuditService,
  ) {}

  async indexLatestTurn(sessionId: string): Promise<HallucinationIndexResult> {
    const msg = this.loadLatestUnindexedAssistant(sessionId);
    if (!msg) {
      return {
        status: "skipped",
        reason: "no unindexed assistant message",
      };
    }

    const specifics = measureSpecifics(msg.content);

    if (
      specifics.lengthChars < TRIVIAL_LENGTH_CHARS &&
      specifics.yearTokens === 0 &&
      specifics.digitWordTokens === 0 &&
      specifics.quotedSubstrings === 0
    ) {
      this.writeIndex(msg.id, 0);
      this.log.log(
        `[index] sessionId=${sessionId} turnId=${msg.turn_id} seq=${msg.seq} fast-path index=0 (len=${specifics.lengthChars})`,
      );
      return {
        status: "indexed",
        hallucinationIndex: 0,
        auditWritten: false,
      };
    }

    let auditResult;
    try {
      auditResult = await this.audit.auditTurn({
        turn: {
          sessionId,
          turnId: msg.turn_id,
          assistantMessageId: msg.id,
        },
        assistantMessageContent: msg.content,
        markers: { specifics },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `[index] sessionId=${sessionId} turnId=${msg.turn_id} audit crashed: ${reason}`,
      );
      return { status: "failed", reason };
    }

    if (auditResult.status === "failed") {
      this.log.warn(
        `[index] sessionId=${sessionId} turnId=${msg.turn_id} audit failed: ${auditResult.reason ?? "unknown"}`,
      );
      return { status: "failed", reason: auditResult.reason };
    }

    const claims = auditResult.claims ?? [];
    const index = computeIndex(claims);
    this.writeIndex(msg.id, index);

    this.log.log(
      `[index] sessionId=${sessionId} turnId=${msg.turn_id} seq=${msg.seq} ` +
        `verdict=${auditResult.turnVerdict ?? "clean"} claims=${claims.length} ` +
        `index=${index}`,
    );

    return {
      status: "indexed",
      hallucinationIndex: index,
      auditWritten: auditResult.status === "written",
    };
  }

  private loadLatestUnindexedAssistant(
    sessionId: string,
  ): AssistantMessageRow | null {
    const row = this.db.connection
      .prepare(
        `SELECT id, turn_id, seq, content, hallucination_index
           FROM messages
          WHERE session_id = ?
            AND role = 'assistant'
            AND hallucination_index IS NULL
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(sessionId) as AssistantMessageRow | undefined;
    return row ?? null;
  }

  private writeIndex(messageId: string, index: number): void {
    this.db.connection
      .prepare(
        `UPDATE messages SET hallucination_index = ? WHERE id = ?`,
      )
      .run(index, messageId);
  }
}

/**
 * Maps per-claim verdicts to a 0–10 turn-level score.
 *
 *   verified     → 0   (claim was supported by evidence)
 *   partial      → 3   (some parts supported, some not)
 *   unverifiable → 5   (no relevant evidence either way)
 *   contradicted → 10  (claim conflicts with evidence)
 *
 * Index is the rounded average across all per-claim contributions.
 * If no claims were checked, the message had nothing factual to
 * audit → index = 0.
 */
function computeIndex(claims: ClaimAudit[]): number {
  if (claims.length === 0) return 0;
  let total = 0;
  for (const c of claims) {
    switch (c.verdict) {
      case "verified":
        total += 0;
        break;
      case "partial":
        total += 3;
        break;
      case "unverifiable":
        total += 5;
        break;
      case "contradicted":
        total += 10;
        break;
    }
  }
  const avg = total / claims.length;
  return Math.min(10, Math.max(0, Math.round(avg)));
}
