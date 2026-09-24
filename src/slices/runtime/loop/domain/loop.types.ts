import type { Event } from "../../../setup/event"
import type { Tool } from "../../../agent/tool"
import type { Task } from "../../../agent/task/domain/task.service"
import type { AccessModule } from "../../../bot/access/access.module"
import type { ChannelModule, IBridleDebugPayload } from "../../../setup/channel"
import type { IThinkingStep, MessagePart } from "../../../setup/channel/domain/channel.types"

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
  /** The person behind the message, apart from `from` (CLEAN-80); see Message.user. */
  user?: { id: string; email?: string }
  channel: string
  isInternal: boolean
  systemPrompt: string
  history: Event[]
  tools: Tool[]
  send: (text: string, parts?: MessagePart[]) => Promise<void>
  streamSend: (channel: string, to: string, streamer: (onChunk: (text: string) => void) => Promise<string>) => Promise<string | void>
  /**
   * Best-effort "agent is working" signal to the originating channel's UI.
   * Fired at turn start and before each tool batch so the user never stares
   * at a dead chat during tool-only phases. Undefined for internal turns and
   * for channels without a typing affordance.
   */
  sendTyping?: () => void
  /**
   * Best-effort thinking-timeline publish: a step update, or (with `step`
   * omitted) the terminal turn-completion signal. Wired only when the
   * triggering message advertised the `thinking` capability — undefined
   * means the client can't render it, so the loop skips emission entirely.
   */
  sendThinking?: (turnId: string, step?: IThinkingStep) => void
  agentConfig: import("../../init").IAgentConfig
  reloadSkills: () => Promise<void>
  access?: AccessModule
  isAdmin: boolean
  /**
   * Live channel registry — passed through to tools so channel_* tools can
   * mutate the agent's own connections (e.g. configure Telegram in-chat).
   */
  channels?: ChannelModule
  /**
   * Best-effort debug-snapshot emitter. Wired from the runtime when the
   * active channel is bridle; otherwise undefined. The loop checks
   * BRIDLE_DEBUG before calling this — the function itself does not gate.
   */
  sendDebug?: (payload: IBridleDebugPayload) => void
}

export interface ILoopResult {
  /** Final accumulated text (may be empty if only tool calls happened) */
  text: string
  /** Whether the error limit was hit */
  errorLimitHit: boolean
}

/**
 * One bubble of an agent turn as the person saw it on a streaming channel:
 * the wire message id, its text, and when it was finalized. Stored on the
 * turn's assistant event as `data.messages` so a transcript replay can show
 * the same bubbles, under the same ids, instead of one glued paragraph.
 * Display-only: prompt builders and the compactor read `data.text`.
 */
export interface IAssistantBubble {
  id: string
  text: string
  ts: number
}
