import type { IInstinct } from "../instinct.types"
import { extractJsonObject } from "../../../../setup/llm/domain/extractJson"

/**
 * The background review prompt (CLEAN-150 US3). Replaces the `[fact]/[workflow]`
 * curator: it still extracts durable facts for MEMORY.md, and in addition
 * turns corrections, resolved errors, repeated workflows and explicit admin
 * rules into instincts — one trigger, one action, with evidence refs.
 *
 * Output is JSON so the runtime can apply it mechanically; `NOTHING` when the
 * conversation taught nothing.
 */
export function buildInstinctReviewPrompt(existingMemory: string, instincts: IInstinct[]): string {
  const known = instincts.length === 0
    ? "(none yet)"
    : instincts.map(i => `- id ${i.id} (${i.confidence}, ${i.source}${i.pinned ? ", pinned" : ""}): when ${i.trigger} → ${i.action}`).join("\n")

  return `You are the agent's memory curator. Review the conversation below and decide what it should learn. Two kinds of output:

1. FACTS — durable knowledge for MEMORY.md (injected into every future session): stable info about the person or environment (emails, accounts, timezone, preferences on how they want things done). Concrete values, not narration.

2. INSTINCTS — behaviours, each with ONE trigger (the situation) and ONE action (what to do). Sources:
   - "correction": the person corrected how the agent behaved ("shorter next time", "don't do X", "always Y").
   - "explicit-rule": an admin stated a standing rule ("never …", "always …", "from now on …"). These become pinned core rules — only report genuine rules addressed to the agent.
   - "error-resolution": a tool error was hit and the conversation found what works instead.
   - "repetition": a multi-step procedure that was done and would be done the same way again.
   For an existing instinct (list below), report {"kind":"reinforce","id":…} when the conversation applied it without complaint, or {"kind":"correct","id":…} when the person pushed back on it. Use "new" only for behaviours not in the list; if a new one contradicts an existing one, set "conflictsWith" to that id.

Rules:
- Never record environment failures ("command not found", missing credentials), negative claims about tools, or transient errors that resolved on retry.
- Never record anything already in CURRENT MEMORY or in KNOWN INSTINCTS.
- Evidence refs are "session:<id>#<eventId>" of the message that shows it; a short note is welcome.
- Respond with JSON only, exactly this shape, or the single word NOTHING:
{"facts":["[fact] …"],"instincts":[{"kind":"new","trigger":"…","action":"…","source":"correction","evidence":[{"ref":"session:…#…","note":"…"}]},{"kind":"reinforce","id":"…"},{"kind":"correct","id":"…"}]}

CURRENT MEMORY:
${existingMemory.trim() || "(empty)"}

KNOWN INSTINCTS:
${known}`
}

/** Parse the review's JSON; `null` for NOTHING or anything that is not the expected shape. */
export function parseInstinctReview(text: string | undefined): { facts: string[]; instincts: unknown[] } | null {
  const t = (text ?? "").trim()
  if (!t || t === "NOTHING") return null
  const parsed = extractJsonObject(t) as { facts?: unknown; instincts?: unknown } | null
  if (!parsed) return null
  return {
    facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f): f is string => typeof f === "string") : [],
    instincts: Array.isArray(parsed.instincts) ? parsed.instincts : [],
  }
}
