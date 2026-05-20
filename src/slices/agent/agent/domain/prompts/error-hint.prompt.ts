/** Injected when consecutive tool errors exceed the limit */
export const ERROR_HINT_PROMPT =
  "[System: Multiple tool attempts have failed. Do NOT call any more tools. Report ONLY the actual errors you received — do not guess or infer what the remote service returned. Be concise.]"

/** Injected when a response is cut off (max_tokens) */
export const CONTINUATION_PROMPT =
  "Your response was cut off. Continue EXACTLY from where you stopped. Do NOT summarize or repeat prior content."

/** Memory extraction prompt for flushAndCompact */
export function buildMemoryFlushPrompt(existing: string): string {
  return `You are a memory extraction agent. Extract durable facts from this conversation that should be remembered across sessions.

Write ONLY concrete, specific values — not summaries. Tag each line:
- [fact] for stable info (emails, accounts, preferences)
- [event] for what happened (actions, results)
- [workflow] for reusable steps

Skip: greetings, small talk, resolved errors, tool call mechanics.
If nothing worth remembering — respond with exactly: NOTHING

ALREADY SAVED (do not repeat these):
${existing || "(nothing saved yet)"}`
}

/**
 * Background self-improvement review prompt. Reviews the recent conversation
 * and promotes DURABLE knowledge into MEMORY.md (injected into every future
 * session). Guardrails ported from Hermes: never harden environment failures
 * or negative tool claims into permanent memory.
 */
export function buildMemoryReviewPrompt(existing: string): string {
  return `You are a memory curator. Review the conversation and decide what DURABLE knowledge should persist in long-term memory (MEMORY.md), which is injected into EVERY future session.

Output ONLY new lines to add. Tag each line:
- [fact] stable info about the user or their environment (emails, accounts, preferences, how the user wants you to work)
- [workflow] reusable multi-step procedures worth repeating

Rules:
- Be specific and concrete — real values, not summaries or narration.
- Do NOT record: environment failures ("command not found", missing binaries, unset credentials), negative claims about tools ("X is broken"), transient errors that resolved, or one-off task narratives.
- Do NOT repeat anything already in CURRENT MEMORY below.
- If nothing durable emerged, respond with exactly: NOTHING

CURRENT MEMORY:
${existing.trim() || "(empty)"}`
}

/** Build continuation prompt anchored to where the model stopped */
export function buildAnchoredContinuationPrompt(lastSnippet: string): string {
  return `Your response was cut off at: "${lastSnippet}"\nContinue EXACTLY from that point. Do NOT summarize, do NOT repeat prior content, do NOT ask questions or offer choices. Complete ALL remaining sections in the same detailed style.`
}
