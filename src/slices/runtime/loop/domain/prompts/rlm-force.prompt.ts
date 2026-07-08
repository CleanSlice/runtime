/**
 * One-shot system-prompt addendum for a turn where the user explicitly
 * toggled "use RLM" in the chat UI (Message.forceRlm). Computed fresh per
 * `buildPrompt()` call from the incoming message, never persisted to
 * session state — so it's non-sticky by construction, same as the
 * resource-hint mechanism it rides alongside.
 */
export function buildRlmForceHintPrompt(): string {
  return (
    `# RLM Requested\n\n` +
    `The user has explicitly requested the Recursive Language Model tool for ` +
    `this turn. You MUST call the RLM tool (visible in your tool list, named ` +
    `something like \`Ranch__rlm_query\`) before composing your final response, ` +
    `even if you believe you already know the answer or would normally use a ` +
    `plain knowledge-search tool instead. Do not skip this.`
  )
}
