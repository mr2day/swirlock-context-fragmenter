import type { LlmMessage } from "../llm-host/llm-host.service";

export interface SessionSummaryPromptInput {
  /** Most recent N messages from the orchestrator's `messages` table, oldest first. */
  recentMessages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  }>;
  /** Previous summary text, if one exists. May be null on first run. */
  previousSummary: string | null;
  /** Number of turns NOT included in `recentMessages` because they precede the slice window. */
  olderTurnCount: number;
}

/**
 * Builds the prompt for the rolling session-summary consolidation.
 *
 * One LLM call. Output is a short plain-text summary that the
 * orchestrator can consume verbatim at prompt-assembly time on the
 * next conversational turn.
 */
export function buildSessionSummaryMessages(
  input: SessionSummaryPromptInput,
): LlmMessage[] {
  const lines: string[] = [
    "You are summarizing a chat conversation for memory purposes.",
    "",
    "Goal: produce a concise, factual rolling summary of the conversation between a user and an assistant. The summary will be re-read on the next turn so the assistant can stay grounded without rereading the full transcript.",
    "",
    "Rules:",
    "- Output 3-6 sentences of plain text only. No preamble, no JSON, no markdown.",
    "- Capture: the main topics discussed, any durable facts the user established about themselves, any open questions or commitments, and any in-progress tasks.",
    "- Do not invent facts; only use what is explicitly in the conversation.",
    "- Write in the same language as the conversation. Do not translate.",
    '- Refer to the participants as "the user" and "the assistant".',
  ];

  if (input.previousSummary) {
    lines.push(
      "",
      "Previous summary of earlier turns (may need refining as new turns arrive):",
      input.previousSummary,
    );
  }

  if (input.olderTurnCount > 0) {
    lines.push(
      "",
      `(${input.olderTurnCount} earlier message(s) are omitted; they are already represented in the previous summary above.)`,
    );
  }

  const transcript = input.recentMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  return [
    { role: "system", content: lines.join("\n") },
    {
      role: "user",
      content: `Recent conversation:\n${transcript}\n\nProduce the updated rolling summary now.`,
    },
  ];
}
