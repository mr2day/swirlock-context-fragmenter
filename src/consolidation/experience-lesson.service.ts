import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";
import { DatabaseService } from "../database/database.service";
import { LlmHostService, type LlmMessage } from "../llm-host/llm-host.service";

type Importance = "core" | "important" | "incidental";

interface AuditRowForDistillation {
  id: string;
  persona_name: string;
  turn_verdict: "hallucinated" | "suspect";
  claims_checked: string;
  corrected_summary: string | null;
  audited_at: string;
}

interface ActiveLessonRow {
  id: string;
  content: string;
  importance: Importance;
  reinforcement_count: number;
}

interface ParsedClaimAudit {
  claim?: string;
  verdict?: string;
  rationale?: string;
}

export interface DistillationSummary {
  personasProcessed: number;
  auditsConsumed: number;
  reinforcedLessons: number;
  newLessons: number;
  failed: number;
}

export interface ExperienceLessonDecayResult {
  demoted: number;
  retired: number;
  promoted: number;
}

const LESSON_PROMPT_AUDIT_PREVIEW_CHARS = 480;

/**
 * Unit F — experience-lesson distillation + decay.
 *
 * Runs in two phases per sleep tick (after the appeal pass):
 *
 *   1. Distillation: for each persona that has new, non-disputed,
 *      appealed audits with verdict `hallucinated` or `suspect`,
 *      ask the Utility LLM to (a) decide which existing active
 *      lessons each audit reinforces, and (b) propose new lessons
 *      for whatever the existing set doesn't already cover.
 *      Reinforced lessons get `reinforcement_count` bumped and
 *      `last_confirmed_at` set; new lessons are inserted.
 *      Consumed audits are marked `distilled_at`.
 *
 *   2. Decay: same shape as Unit B's identity decay. Lessons that
 *      were not reinforced for K consecutive sleep ticks are
 *      demoted; `incidental` lessons that fail to be reinforced for
 *      another K ticks are retired (`superseded_at` set). Lessons
 *      with enough accumulated reinforcements are promoted one
 *      tier.
 *
 * Per-persona scoping is hard-wired (decision Q2 in REALITY_DRIFT.md).
 */
@Injectable()
export class ExperienceLessonService {
  private readonly log = new Logger(ExperienceLessonService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
  ) {}

  async runDistillationPass(): Promise<DistillationSummary> {
    const personas = this.listPersonasWithPendingAudits();
    const summary: DistillationSummary = {
      personasProcessed: 0,
      auditsConsumed: 0,
      reinforcedLessons: 0,
      newLessons: 0,
      failed: 0,
    };
    if (personas.length === 0) {
      this.log.log(
        "distillation: no personas with pending audits; skipping LLM pass.",
      );
      return summary;
    }
    this.log.log(
      `distillation: ${personas.length} persona(s) with pending audits.`,
    );

    for (const persona of personas) {
      try {
        const result = await this.distillPersona(persona);
        summary.personasProcessed += 1;
        summary.auditsConsumed += result.auditsConsumed;
        summary.reinforcedLessons += result.reinforcedLessons;
        summary.newLessons += result.newLessons;
      } catch (err) {
        summary.failed += 1;
        this.log.warn(
          `distillation: persona ${persona} crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.log.log(
      `distillation: done — personas=${summary.personasProcessed} auditsConsumed=${summary.auditsConsumed} reinforced=${summary.reinforcedLessons} new=${summary.newLessons} failed=${summary.failed}`,
    );
    return summary;
  }

  /**
   * Repeatability-driven decay over experience lessons. Identical
   * mechanism to Unit B's identity decay, scoped to one
   * (per-persona) table.
   */
  applyDecayPass(): ExperienceLessonDecayResult {
    const quietThreshold = this.cfg.consolidation.quietThresholdMs;
    const barrenTicks = this.cfg.consolidation.decayBarrenTicks;
    const promoteThreshold =
      this.cfg.consolidation.promotionReinforcementThreshold;
    const now = new Date();
    const nowIso = now.toISOString();
    const decayCutoffMs = now.getTime() - quietThreshold * barrenTicks;
    const decayCutoffIso = new Date(decayCutoffMs).toISOString();

    const txn = this.db.connection.transaction(() => {
      const retired = this.db.connection
        .prepare(
          `UPDATE fragmenter_experience_lessons
              SET superseded_at = ?
            WHERE superseded_at IS NULL
              AND importance = 'incidental'
              AND last_confirmed_at IS NOT NULL
              AND last_confirmed_at < ?`,
        )
        .run(nowIso, decayCutoffIso).changes;

      const demoted = this.db.connection
        .prepare(
          `UPDATE fragmenter_experience_lessons
              SET importance = CASE importance
                    WHEN 'core' THEN 'important'
                    WHEN 'important' THEN 'incidental'
                    ELSE importance
                  END,
                  last_confirmed_at = ?,
                  reinforcement_count = 0
            WHERE superseded_at IS NULL
              AND importance IN ('core', 'important')
              AND last_confirmed_at IS NOT NULL
              AND last_confirmed_at < ?`,
        )
        .run(nowIso, decayCutoffIso).changes;

      const promotedToCore = this.db.connection
        .prepare(
          `UPDATE fragmenter_experience_lessons
              SET importance = 'core',
                  reinforcement_count = 0
            WHERE superseded_at IS NULL
              AND importance = 'important'
              AND reinforcement_count >= ?`,
        )
        .run(promoteThreshold * 2).changes;

      const promotedToImportant = this.db.connection
        .prepare(
          `UPDATE fragmenter_experience_lessons
              SET importance = 'important',
                  reinforcement_count = 0
            WHERE superseded_at IS NULL
              AND importance = 'incidental'
              AND reinforcement_count >= ?`,
        )
        .run(promoteThreshold).changes;

      return {
        demoted,
        retired,
        promoted: promotedToCore + promotedToImportant,
      };
    });

    const result = txn();
    if (result.demoted + result.retired + result.promoted > 0) {
      this.log.log(
        `distillation: decay pass — demoted ${result.demoted}, retired ${result.retired}, promoted ${result.promoted}.`,
      );
    } else {
      this.log.log(
        `distillation: decay pass — no changes (all lessons within barren window or below promotion threshold).`,
      );
    }
    return result;
  }

  // ---------------- per-persona distillation ----------------

  private async distillPersona(
    personaName: string,
  ): Promise<{
    auditsConsumed: number;
    reinforcedLessons: number;
    newLessons: number;
  }> {
    const audits = this.loadPendingAudits(personaName);
    if (audits.length === 0) {
      return { auditsConsumed: 0, reinforcedLessons: 0, newLessons: 0 };
    }
    const activeLessons = this.loadActiveLessons(personaName);
    const correlationId = `cf:distill:${randomUUID()}`;

    const messages = buildDistillationPromptMessages(
      personaName,
      audits,
      activeLessons,
    );

    const result = await this.llm.streamInfer({
      correlationId,
      messages,
      options: {
        responseFormat: "json",
        thinking: false,
        ollama: { temperature: 0.0 },
      },
    });

    const parsed = parseDistillationJson(result.text);
    if (!parsed) {
      this.log.warn(
        `distillation: persona ${personaName} returned unparseable JSON; preview="${result.text.replace(/\s+/g, " ").slice(0, 180)}"`,
      );
      return { auditsConsumed: 0, reinforcedLessons: 0, newLessons: 0 };
    }

    const validLessonIds = new Set(activeLessons.map((l) => l.id));
    const validAuditIds = new Set(audits.map((a) => a.id));

    const reinforcements = parsed.reinforcements.filter(
      (r) =>
        validLessonIds.has(r.lessonId) && validAuditIds.has(r.auditId),
    );
    const newLessons = parsed.newLessons
      .filter((l) => l.content.trim().length > 0)
      .map((l) => ({
        ...l,
        sourceAuditIds: l.sourceAuditIds.filter((id) =>
          validAuditIds.has(id),
        ),
      }));

    const nowIso = new Date().toISOString();
    const reinforcedLessonIds = new Set(
      reinforcements.map((r) => r.lessonId),
    );

    this.db.connection.transaction(() => {
      // Reinforce existing lessons.
      const bumpStmt = this.db.connection.prepare(
        `UPDATE fragmenter_experience_lessons
            SET reinforcement_count = reinforcement_count + 1,
                last_confirmed_at = ?
          WHERE id = ? AND superseded_at IS NULL`,
      );
      for (const lessonId of reinforcedLessonIds) {
        bumpStmt.run(nowIso, lessonId);
      }

      // Insert new lessons.
      const insertStmt = this.db.connection.prepare(
        `INSERT INTO fragmenter_experience_lessons
           (id, persona_name, content, importance, source_audit_ids,
            generated_at, last_confirmed_at, reinforcement_count,
            superseded_at, superseded_by_id, fragmenter_correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)`,
      );
      for (const lesson of newLessons) {
        insertStmt.run(
          randomUUID(),
          personaName,
          lesson.content.trim(),
          lesson.importance,
          JSON.stringify(lesson.sourceAuditIds),
          nowIso,
          nowIso,
          correlationId,
        );
      }

      // Mark all audits we considered as distilled.
      const markStmt = this.db.connection.prepare(
        `UPDATE fragmenter_answer_audits
            SET distilled_at = ?
          WHERE id = ?`,
      );
      for (const audit of audits) {
        markStmt.run(nowIso, audit.id);
      }
    })();

    this.log.log(
      `distillation: persona ${personaName} — consumed ${audits.length} audit(s); reinforced ${reinforcedLessonIds.size} lesson(s); created ${newLessons.length} new lesson(s).`,
    );
    return {
      auditsConsumed: audits.length,
      reinforcedLessons: reinforcedLessonIds.size,
      newLessons: newLessons.length,
    };
  }

  // ---------------- DB helpers ----------------

  private listPersonasWithPendingAudits(): string[] {
    const rows = this.db.connection
      .prepare(
        `SELECT DISTINCT persona_name
           FROM fragmenter_answer_audits
          WHERE persona_name IS NOT NULL
            AND turn_verdict IN ('hallucinated', 'suspect')
            AND disputed = 0
            AND appealed_at IS NOT NULL
            AND distilled_at IS NULL`,
      )
      .all() as Array<{ persona_name: string }>;
    return rows.map((r) => r.persona_name);
  }

  private loadPendingAudits(
    personaName: string,
  ): AuditRowForDistillation[] {
    return this.db.connection
      .prepare(
        `SELECT id, persona_name, turn_verdict, claims_checked,
                corrected_summary, audited_at
           FROM fragmenter_answer_audits
          WHERE persona_name = ?
            AND turn_verdict IN ('hallucinated', 'suspect')
            AND disputed = 0
            AND appealed_at IS NOT NULL
            AND distilled_at IS NULL
          ORDER BY audited_at ASC`,
      )
      .all(personaName) as AuditRowForDistillation[];
  }

  private loadActiveLessons(personaName: string): ActiveLessonRow[] {
    return this.db.connection
      .prepare(
        `SELECT id, content, importance, reinforcement_count
           FROM fragmenter_experience_lessons
          WHERE persona_name = ?
            AND superseded_at IS NULL
          ORDER BY
            CASE importance
              WHEN 'core' THEN 0
              WHEN 'important' THEN 1
              ELSE 2
            END,
            generated_at ASC`,
      )
      .all(personaName) as ActiveLessonRow[];
  }
}

// ---------------- prompt + parser ----------------

interface ParsedDistillation {
  reinforcements: Array<{ auditId: string; lessonId: string }>;
  newLessons: Array<{
    content: string;
    importance: Importance;
    sourceAuditIds: string[];
  }>;
}

function buildDistillationPromptMessages(
  personaName: string,
  audits: AuditRowForDistillation[],
  activeLessons: ActiveLessonRow[],
): LlmMessage[] {
  const system = [
    `You are distilling behavioural lessons for the persona "${personaName}" from a batch of audit records where the assistant produced unsupported or contradicted factual claims.`,
    "",
    "You are given:",
    "  (a) `existing_lessons`: a list of behavioural lessons already on file for this persona. Each has an id, content, and importance tier.",
    "  (b) `audits`: a list of fresh audit records. Each has an id, a turn_verdict (`hallucinated` or `suspect`), the claim-by-claim verdicts, and a short corrected_summary describing what went wrong.",
    "",
    "Your job is to output:",
    "  1. `reinforcements`: a mapping from audit ids to existing lesson ids. An audit reinforces a lesson when the lesson's behavioural advice would have prevented the audit's mistake. An audit may reinforce multiple lessons; an audit may also reinforce none.",
    "  2. `new_lessons`: behavioural lessons to create for whatever the existing set does not already cover. Each new lesson must be a short third-person sentence about the assistant, phrased as actionable behaviour for the future (e.g. \"I should not quote interview statements unless a source is attached on the same turn.\"). Do NOT just describe what went wrong; describe what to do differently.",
    "",
    "Output STRICT JSON only — no prose, no code fences. Schema:",
    `{
  "reinforcements": [{"audit_id": <string>, "lesson_id": <string>}],
  "new_lessons": [
    {
      "content": <string, the behavioural sentence>,
      "importance": "core" | "important" | "incidental",
      "source_audit_ids": [<string>, ...]
    }
  ]
}`,
    "",
    "Rules:",
    "- Be parsimonious with new lessons. Prefer reinforcing an existing lesson if it covers the same pattern, even loosely. Multiple audits about the same recurring failure mode should reinforce one lesson, not spawn many.",
    "- A lesson's `importance` should reflect breadth of risk: `core` = a pattern affecting many topics, `important` = a recurring family of mistakes, `incidental` = a one-off observation.",
    "- `source_audit_ids` MUST be a subset of the input audit ids; do not invent ids.",
    "- If existing lessons fully cover all audits, return `\"new_lessons\": []`.",
    "- If no existing lesson plausibly matches a given audit and the audit doesn't justify a fresh lesson (e.g. claims were noise, not behavioural patterns), neither reinforce nor create — simply omit the audit. It will still be marked distilled.",
    "- Output language: English.",
  ].join("\n");

  const existingLessonsBlock =
    activeLessons.length === 0
      ? "(no existing lessons)"
      : activeLessons
          .map(
            (l) =>
              `id=${l.id} importance=${l.importance} reinforcements=${l.reinforcement_count}\n  ${l.content}`,
          )
          .join("\n");

  const auditBlocks = audits
    .map((a) => buildAuditBlock(a))
    .join("\n\n");

  const user = [
    "existing_lessons:",
    existingLessonsBlock,
    "",
    "audits:",
    auditBlocks,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildAuditBlock(audit: AuditRowForDistillation): string {
  const parsedClaims = parseClaimsJson(audit.claims_checked);
  const claimLines = parsedClaims
    .map(
      (c, i) =>
        `  [${i + 1}] verdict=${c.verdict ?? "?"} claim="${truncate(c.claim ?? "", 240)}"\n      why: ${truncate(c.rationale ?? "", 200)}`,
    )
    .join("\n");

  return [
    `id=${audit.id} verdict=${audit.turn_verdict}`,
    `corrected_summary: ${truncate(audit.corrected_summary ?? "(none)", LESSON_PROMPT_AUDIT_PREVIEW_CHARS)}`,
    claimLines.length > 0 ? `claims:\n${claimLines}` : "claims: (none)",
  ].join("\n");
}

function parseClaimsJson(raw: string): ParsedClaimAudit[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ParsedClaimAudit =>
        typeof c === "object" && c !== null,
    );
  } catch {
    return [];
  }
}

function parseDistillationJson(raw: string): ParsedDistillation | null {
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

  const reinforcementsRaw = Array.isArray(obj.reinforcements)
    ? obj.reinforcements
    : [];
  const reinforcements: ParsedDistillation["reinforcements"] = [];
  for (const entry of reinforcementsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const auditId =
      typeof e.audit_id === "string" ? e.audit_id.trim() : "";
    const lessonId =
      typeof e.lesson_id === "string" ? e.lesson_id.trim() : "";
    if (auditId && lessonId) {
      reinforcements.push({ auditId, lessonId });
    }
  }

  const newLessonsRaw = Array.isArray(obj.new_lessons) ? obj.new_lessons : [];
  const newLessons: ParsedDistillation["newLessons"] = [];
  for (const entry of newLessonsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const content = typeof e.content === "string" ? e.content.trim() : "";
    if (!content) continue;
    const importance =
      e.importance === "core" ||
      e.importance === "important" ||
      e.importance === "incidental"
        ? e.importance
        : "important";
    const sourceAuditIdsRaw = Array.isArray(e.source_audit_ids)
      ? e.source_audit_ids
      : [];
    const sourceAuditIds = sourceAuditIdsRaw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    newLessons.push({ content, importance, sourceAuditIds });
  }

  return { reinforcements, newLessons };
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3).trimEnd()}...`;
}
