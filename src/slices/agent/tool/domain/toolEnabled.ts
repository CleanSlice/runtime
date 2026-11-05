import type { Tool } from "./tool.types"

/**
 * `tools.enabled` of agent.config.json: the built-in tools this agent keeps
 * (CLEAN-214). Empty or absent keeps every tool, as before.
 *
 * The Mazda product agent had 41 built-in tools in every prompt — exec, file,
 * cron, telegram, secrets, channels — next to the three Documents tools it
 * actually uses: 5.6k characters of catalogue and an open invitation to call
 * `http` instead of searching. The template allowlist of ranch (CLEAN-209)
 * governs only MCP tools; this list governs the runtime's own.
 *
 * MCP tools (`Server__tool`) are never touched here, and the two tools the
 * catalogue mechanism itself needs stay whatever the list says.
 */
export const ALWAYS_ENABLED_TOOLS: readonly string[] = ["skill_load", "tool_describe"]

export function isMcpTool(name: string): boolean {
  return name.includes("__")
}

/**
 * Removes, in place, every built-in tool the list does not name, and returns
 * the names it removed. In place because the array is the live registry the
 * MCP service later edits; a copy would leave the loop with a stale one.
 */
export function pruneDisabledTools(tools: Tool[], enabled: readonly string[] | undefined): string[] {
  if (!enabled || enabled.length === 0) return []
  const keep = new Set([...enabled, ...ALWAYS_ENABLED_TOOLS])
  const dropped: string[] = []
  for (let i = tools.length - 1; i >= 0; i--) {
    const name = tools[i].name
    if (isMcpTool(name) || keep.has(name)) continue
    dropped.unshift(name)
    tools.splice(i, 1)
  }
  return dropped
}
