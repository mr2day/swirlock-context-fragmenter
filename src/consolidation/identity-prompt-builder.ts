import type { LlmMessage } from "../llm-host/llm-host.service";

export type ImportanceTier = "core" | "important" | "incidental";

export interface ExistingIdentityFact {
  content: string;
  importance: ImportanceTier;
}

export interface ExtractedFact {
  content: string;
  importance: ImportanceTier;
}

export interface IdentityExtractionInput {
  /** Which side the facts are about. */
  subject: "user" | "assistant";
  /** Recent session summary text (single rolling summary from `fragmenter_session_summaries`). */
  sessionSummary: string;
  /** Currently-active identity facts for this subject — already-known durable info. */
  existingFacts: ExistingIdentityFact[];
}

const IMPORTANCE_GUIDE = `Importance tiers:
- core: identity-defining; almost never changes (name, profession, language, durable preferences, persistent goals).
- important: recurring or behavior-shaping; matters across sessions (working style, ongoing project, strong opinions, known relationships).
- incidental: one-off mentions worth remembering for context but not central (a specific question they once asked, a passing reference).`;

/**
 * Builds the prompt for the per-(user|persona) identity-fact extraction
 * pass. The fragmenter LLM is asked to read the latest session summary
 * plus any already-known facts and emit STRICT JSON of NEW facts that
 * are not already covered. Sleep handles deduplication and merging
 * later — the extraction pass is intentionally additive.
 */
export function buildIdentityExtractionMessages(
  input: IdentityExtractionInput,
): LlmMessage[] {
  const subjectLabel =
    input.subject === "user"
      ? "the user (the human in the conversation)"
      : "the assistant (the chatbot/persona)";

  const systemLines: string[] = [
    `You extract durable identity facts about ${subjectLabel} from a chat-session summary.`,
    "",
    "Goal: find facts that will still be useful several sessions from now — things that define who they are, what they do, how they prefer to interact, what ongoing concerns they hold.",
    "",
    "Strict rules:",
    "- Output STRICT JSON only. Schema: {\"facts\": [{\"content\": string, \"importance\": \"core\"|\"important\"|\"incidental\"}]}.",
    "- No prose before or after the JSON. No code fences.",
    `- Each fact must be about ${subjectLabel}, not the other party.`,
    "- Each fact must be one short sentence (≤ 25 words), written in third person, in the same language as the summary.",
    "- Do NOT invent facts. If the summary does not establish anything new, return {\"facts\": []}.",
    "- Do NOT re-emit facts that are already in the 'Already known facts' section below — those are tracked. Only emit genuinely new information OR a clear correction/refinement of an existing fact (in which case mark importance high enough to override).",
    "- Hard cap: at most 6 facts per extraction run.",
    "",
    IMPORTANCE_GUIDE,
  ];

  const userLines: string[] = [];

  if (input.existingFacts.length > 0) {
    userLines.push("Already known facts (do not repeat):");
    for (const fact of input.existingFacts) {
      userLines.push(`- [${fact.importance}] ${fact.content}`);
    }
    userLines.push("");
  } else {
    userLines.push("No facts are known yet for this subject.");
    userLines.push("");
  }

  userLines.push("Latest session summary:");
  userLines.push(input.sessionSummary);
  userLines.push("");
  userLines.push(
    `Extract durable identity facts about ${subjectLabel} as STRICT JSON now.`,
  );

  return [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n") },
  ];
}

export interface IdentityMergeInput {
  subject: "user" | "assistant";
  /** All currently-active facts for the subject, regardless of importance. */
  currentFacts: ExistingIdentityFact[];
}

/**
 * Builds the prompt for the periodic sleep-merge pass.
 *
 * Given the full active fact set for one subject, the LLM rewrites a
 * consolidated, deduplicated, re-tiered list. The fragmenter then
 * marks all old rows as superseded and inserts new ones from the
 * merged output.
 */
export function buildIdentityMergeMessages(
  input: IdentityMergeInput,
): LlmMessage[] {
  const subjectLabel =
    input.subject === "user"
      ? "the user (the human)"
      : "the assistant (the chatbot/persona)";

  const systemLines: string[] = [
    `You consolidate durable identity facts about ${subjectLabel}.`,
    "",
    "Goal: take a possibly redundant or contradictory list of facts and produce a clean, deduplicated, well-tiered version. Merge near-duplicates. Drop incidental facts that are subsumed by more important ones. Promote a fact's importance if multiple incidents reinforce it; demote stale ones.",
    "",
    "Strict rules:",
    "- Output STRICT JSON only. Schema: {\"facts\": [{\"content\": string, \"importance\": \"core\"|\"important\"|\"incidental\"}]}.",
    "- No prose, no code fences.",
    "- Each fact one short sentence (≤ 25 words), third person, same language as the inputs.",
    "- Do NOT invent facts that are not supported by the inputs.",
    "- Hard cap: at most 24 facts total in the output.",
    "- If two input facts contradict, keep the more recently asserted or higher-importance variant; drop the other.",
    "",
    IMPORTANCE_GUIDE,
  ];

  const userLines: string[] = [];
  userLines.push("Current facts (sleep-pass consolidation input):");
  for (const fact of input.currentFacts) {
    userLines.push(`- [${fact.importance}] ${fact.content}`);
  }
  userLines.push("");
  userLines.push("Produce the consolidated fact list as STRICT JSON now.");

  return [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n") },
  ];
}

/**
 * Permissive parser for the JSON the fragmenter LLM emits. Accepts a
 * leading code fence or a trailing comment. Returns an empty fact list
 * on any parse error rather than throwing — extraction is best-effort.
 */
export function parseExtractedFacts(text: string): ExtractedFact[] {
  const stripped = stripCodeFences(text).trim();
  if (!stripped) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to extract the first { ... } block.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];

  const out: ExtractedFact[] = [];
  for (const raw of facts) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as { content?: unknown; importance?: unknown };
    const content =
      typeof r.content === "string" ? r.content.trim() : "";
    const importance = normalizeImportance(r.importance);
    if (!content || !importance) continue;
    out.push({ content, importance });
  }
  return out;
}

function normalizeImportance(value: unknown): ImportanceTier | null {
  if (value === "core" || value === "important" || value === "incidental") {
    return value;
  }
  return null;
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  return text;
}
