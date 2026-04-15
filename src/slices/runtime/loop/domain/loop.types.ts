import type { Event } from "../../../setup/event"
import type { Tool } from "../../../agent/tool"
import type { Task } from "../../../agent/task/domain/task.service"
import type { AccessModule } from "../../../bot/access/access.module"

export interface ILoopConfig {
  maxIterations: number
  maxConsecutiveErrors: number
  maxContinuations: number
  toolTimeout: number
}

export const LOOP_DEFAULTS: ILoopConfig = {
  maxIterations: 25,
  maxConsecutiveErrors: 3,
  maxContinuations: 4,
  toolTimeout: 120_000,
}

export interface ILoopContext {
  task: Task
  sessionId: string
  agentDir: string
  from: string
  channel: string
  isInternal: boolean
  systemPrompt: string
  history: Event[]
  tools: Tool[]
  send: (text: string) => Promise<void>
  streamSend: (channel: string, to: string, streamer: (onChunk: (text: string) => void) => Promise<string>) => Promise<void>
  agentConfig: import("../init").IAgentConfig
  reloadSkills: () => Promise<void>
  access?: AccessModule
  isAdmin: boolean
}

export interface ILoopResult {
  /** Final accumulated text (may be empty if only tool calls happened) */
  text: string
  /** Whether the error limit was hit */
  errorLimitHit: boolean
}
