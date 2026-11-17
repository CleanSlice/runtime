/**
 * Text meant for the agent's administrators only sits between
 * `<!-- admin-only -->` and `<!-- /admin-only -->`. It is taken out of
 * everything a turn reads when its sender is not an admin: SOUL.md, USER.md,
 * MEMORY.md, HEARTBEAT.md and the body of a skill (CLEAN-232).
 */
const ADMIN_BLOCK_RE = /<!--\s*admin-only\s*-->[\s\S]*?<!--\s*\/admin-only\s*-->/g

export function stripAdminBlocks(text: string): string
export function stripAdminBlocks(text: string | undefined): string | undefined
export function stripAdminBlocks(text: string | undefined): string | undefined {
  if (!text) return text
  return text.replace(ADMIN_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim()
}
