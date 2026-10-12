import type { Event } from "../../../setup/event"
import type { Skill } from "./skill.types"

/**
 * A loaded skill as a history event (CLEAN-150 US2). It rides as a `summary`
 * — the one event type every LLM adapter already renders as context — tagged
 * with the skill name so the runtime can find, refresh and expire it without
 * touching the cached system prompt.
 */
export function skillEvent(skill: Skill): Event {
  return {
    id: `skill-${skill.name}`,
    type: "summary",
    ts: Date.now(),
    data: {
      skill: skill.name,
      text: `[SKILL ${skill.name}] Instructions loaded for this conversation — follow them.\n\n${skill.content.trim()}\n[END SKILL ${skill.name}]`,
    },
  }
}

/** True for a history event produced by `skillEvent`. */
export function isSkillEvent(event: Event): boolean {
  return event.type === "summary" && typeof (event.data as { skill?: unknown })?.skill === "string"
}
