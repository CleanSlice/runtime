import type { IAgentGateway } from "./agent.gateway"
import type { AgentConfig } from "./agent.types"
import type { SkillSummary } from "../../skill/domain/skill.types"
import { SILENT_REPLY_TOKEN } from "./silentReply"

export interface BuildPromptOpts {
  agentDir?: string
  toolingPrompt?: string
  secretKeys?: string[]
  dailyMemory?: string
  skills?: SkillSummary[]
  isAdmin?: boolean
  /**
   * One-shot system-prompt addendum, prepended near the top. Used by the
   * runtime to surface "your previous turn was delayed" notices that point
   * the agent at the `resource_status` tool.
   */
  extraHint?: string
}

const ADMIN_BLOCK_RE = /<!--\s*admin-only\s*-->[\s\S]*?<!--\s*\/admin-only\s*-->/g

function stripAdminBlocks(text: string | undefined): string | undefined {
  if (!text) return text
  return text.replace(ADMIN_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Returns true if the message is empty or contains only whitespace.
 * These messages must be answered with "What can I help you with?"
 * without calling any tools or doing any processing.
 */
export function isEmptyMessage(message: string): boolean {
  return message.trim() === ""
}

/**
 * The exact response to return for empty/whitespace-only messages.
 */
export const EMPTY_MESSAGE_RESPONSE = "What can I help you with?"

export class AgentService {
  constructor(private gateway: IAgentGateway) {}

  async load(agentDir: string): Promise<AgentConfig> {
    return this.gateway.load(agentDir)
  }

  buildSystemPrompt(config: AgentConfig, opts?: BuildPromptOpts): string {
    const parts: string[] = []
    const isAdmin = opts?.isAdmin ?? false
    const gate = (text: string | undefined) => isAdmin ? text : stripAdminBlocks(text)

    const soul = gate(config.soul)
    const agents = gate(config.agents)
    const user = gate(config.user)
    const memory = gate(config.memory)

    if (soul)              parts.push(`# Soul\n\n${soul}`)
    if (opts?.extraHint)   parts.push(opts.extraHint)
    if (opts?.toolingPrompt) parts.push(opts.toolingPrompt)
    if (agents)            parts.push(`# Agent Instructions\n\n${agents}`)
    if (user)              parts.push(`# User Context\n\n${user}`)
    if (memory)            parts.push(`# Memory\n\n${memory}`)

    if (opts?.dailyMemory) {
      parts.push(`## Recent Notes\n\n${opts.dailyMemory}`)
    }

    if (config.heartbeat) parts.push(`# Heartbeat\n\n${config.heartbeat}`)

    // Skill catalog: only names + descriptions (full content loaded on demand)
    const allSkills = [...config.skills, ...(opts?.skills ?? [])]
    if (allSkills.length > 0) {
      const catalog = allSkills
        .map(s => `- **${s.name}**: ${s.description}`)
        .join("\n")
      parts.push(`# Available Skills\n\nThese skills are loaded automatically when relevant to the task.\n\n${catalog}`)
    }

    if (opts?.secretKeys && opts.secretKeys.length > 0) {
      parts.push(
        `## Saved Credentials\n\n` +
        `This user has the following secrets already stored. Use \`secret_get\` to retrieve values when needed — do NOT ask the user to provide them again.\n\n` +
        opts.secretKeys.map(k => `- \`${k}\``).join("\n")
      )
    }

    if (opts?.agentDir) {
      parts.push(
        `# Runtime\n\n` +
        `Agent dir: ${opts.agentDir}\n` +
        `Skills dir: ${opts.agentDir}/skills/\n` +
        `Workspace dir: ${opts.agentDir}/workspace/\n\n` +
        `Use workspace dir for cloning repos, writing files, and project work. It persists across restarts.\n` +
        `To create a skill, use the \`skill_write\` tool with name, description, and content. The skill will be immediately active.`
      )
    }

    parts.push(
      `# Staying Silent\n\n` +
      `When you have genuinely nothing to say to the user — e.g. a recovery instruction told you to resume silently and the task was already complete, or a background event arrived after you already replied — respond with ONLY the literal token below and nothing else:\n\n` +
      `\`${SILENT_REPLY_TOKEN}\`\n\n` +
      `Rules:\n` +
      `- Must be the entire reply. No prefix, no suffix, no quotes, no explanation.\n` +
      `- Never append \`${SILENT_REPLY_TOKEN}\` to a real reply — pick one or the other.\n` +
      `- Do not use it to dodge work. Use it only when sending any message would be noise.\n` +
      `- The runtime suppresses this token: the user sees nothing.`
    )

    return parts.join("\n\n---\n\n")
  }

  async buildPrompt(agentDir: string, opts?: { userId?: string; toolingPrompt?: string; secretKeys?: string[]; dailyMemory?: string; skills?: SkillSummary[]; isAdmin?: boolean; extraHint?: string }): Promise<string> {
    const config = await this.load(agentDir)

    // Override user context with per-user file if it exists
    if (opts?.userId) {
      const userContext = await this.gateway.loadUserContext(agentDir, opts.userId)
      if (userContext?.trim()) config.user = userContext
    }

    return this.buildSystemPrompt(config, {
      agentDir,
      toolingPrompt: opts?.toolingPrompt,
      secretKeys: opts?.secretKeys,
      dailyMemory: opts?.dailyMemory,
      skills: opts?.skills,
      isAdmin: opts?.isAdmin,
      extraHint: opts?.extraHint,
    })
  }
}
