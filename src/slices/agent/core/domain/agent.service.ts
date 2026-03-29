import type { IAgentGateway } from "./agent.gateway"
import type { AgentConfig } from "./agent.types"

export interface BuildPromptOpts {
  agentDir?: string
  toolingPrompt?: string
  secretKeys?: string[]
  dailyMemory?: string
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
 * Returns true if the message is very long (over ~3000 characters).
 * These messages should be skimmed for intent and answered concisely.
 */
export function isVeryLongMessage(message: string): boolean {
  return message.length > 3000
}

/**
 * Returns true if the message appears to be highly repetitive
 * (same short token repeated many times).
 */
export function isRepetitiveMessage(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.length < 100) return false

  // Split into words/tokens and check if a single token dominates
  const words = trimmed.split(/\s+/)
  if (words.length < 10) return false

  const freq: Record<string, number> = {}
  for (const w of words) {
    const key = w.toLowerCase()
    freq[key] = (freq[key] ?? 0) + 1
  }

  const topCount = Math.max(...Object.values(freq))
  // If the most frequent token makes up >60% of words, it's repetitive
  return topCount / words.length > 0.6
}

/**
 * The exact response to return for empty/whitespace-only messages.
 */
export const EMPTY_MESSAGE_RESPONSE = "What can I help you with?"

/**
 * The response to return for very long repetitive messages with no extractable intent.
 */
export const REPETITIVE_MESSAGE_RESPONSE = "Looks like repeated text. What do you need help with?"

export class AgentService {
  constructor(private gateway: IAgentGateway) {}

  async load(agentDir: string): Promise<AgentConfig> {
    return this.gateway.load(agentDir)
  }

  buildSystemPrompt(config: AgentConfig, opts?: BuildPromptOpts): string {
    const parts: string[] = []
    if (config.soul)      parts.push(`# Soul\n\n${config.soul}`)
    if (opts?.toolingPrompt) parts.push(opts.toolingPrompt)
    if (config.agents)    parts.push(`# Agent Instructions\n\n${config.agents}`)
    if (config.user)      parts.push(`# User Context\n\n${config.user}`)
    if (config.memory)    parts.push(`# Memory\n\n${config.memory}`)

    if (opts?.dailyMemory) {
      parts.push(`## Recent Notes\n\n${opts.dailyMemory}`)
    }

    if (config.heartbeat) parts.push(`# Heartbeat\n\n${config.heartbeat}`)
    for (const skill of config.skills) parts.push(`# Skill\n\n${skill}`)

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

    parts.push(`# Context Recall Rules

When the user says "я кидал выше", "я скидав вище", "I sent you earlier", "see above", "ты уже знаешь", "я давав тебе" — DO NOT ask them to repeat.
Instead:
1. Search [ARCHIVED CONTEXT] blocks in the conversation history for the relevant value
2. Check memory/secrets if applicable
3. Only ask once, specifically, if the value is truly not found anywhere: "Could not find <X>, please send it again"

NEVER say "you mentioned earlier but I don't have access to that" if there's an [ARCHIVED CONTEXT] block — search it first.`)

    return parts.join("\n\n---\n\n")
  }

  async buildPrompt(agentDir: string, opts?: { userId?: string; toolingPrompt?: string; secretKeys?: string[]; dailyMemory?: string }): Promise<string> {
    const config = await this.load(agentDir)

    // Override user context with per-user file if it exists
    if (opts?.userId) {
      const userFile = `${agentDir}/users/${opts.userId}.md`
      try {
        const userContext = await Bun.file(userFile).text()
        if (userContext.trim()) config.user = userContext
      } catch {
        // No per-user file — use default USER.md
      }
    }

    return this.buildSystemPrompt(config, { agentDir, toolingPrompt: opts?.toolingPrompt, secretKeys: opts?.secretKeys, dailyMemory: opts?.dailyMemory })
  }
}
