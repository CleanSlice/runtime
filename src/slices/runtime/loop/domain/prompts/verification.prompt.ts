import { extractJsonObject } from "../../../../setup/llm/domain/extractJson"

/** One mutating tool call of the turn, as the verifier sees it. */
export interface IToolOutcome {
  tool: string
  outcome: "ok" | "error" | "blocked" | "timeout"
  /** First characters of the serialized result. */
  result: string
}

export const OUTCOME_PREVIEW_CHARS = 400

/**
 * The completion check (CLEAN-150 US5). The verifier sees only what the
 * tools actually returned and the draft reply; it may pass the draft or
 * rewrite it into a factual report. It never adds work, tools or promises.
 */
export function buildVerificationPrompt(outcomes: IToolOutcome[], draft: string): string {
  const lines = outcomes.map((o, i) => `${i + 1}. ${o.tool} → ${o.outcome}${o.result ? `: ${o.result}` : ""}`).join("\n")
  return `You check an assistant's reply against what its tools actually did. The assistant ran tools that change things (commands, writes, API calls, messages); below are their real outcomes, then the reply it is about to send.

Decide:
- If every claim of success, completion or change in the reply is supported by a successful outcome, answer {"ok":true}.
- If the reply claims something the outcomes do not support — says "done", "sent", "updated", "created", "fixed" while the matching tool errored, was blocked, timed out, or never ran — answer {"ok":false,"reply":"<rewritten reply>"}.

The rewritten reply must: keep the assistant's voice and language; state plainly what succeeded and what did not; quote the real error, status or block reason; not invent next steps that were not taken; stay about as short as the draft.

Respond with JSON only.

TOOL OUTCOMES:
${lines || "(none)"}

DRAFT REPLY:
${draft}`
}

export function parseVerification(text: string | undefined): { ok: true } | { ok: false; reply: string } | null {
  const parsed = extractJsonObject(text) as { ok?: unknown; reply?: unknown } | null
  if (!parsed) return null
  if (parsed.ok === true) return { ok: true }
  if (parsed.ok === false && typeof parsed.reply === "string" && parsed.reply.trim()) return { ok: false, reply: parsed.reply.trim() }
  return null
}
