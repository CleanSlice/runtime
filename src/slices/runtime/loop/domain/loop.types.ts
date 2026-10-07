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
  /** Total serialized size a tool result may take in the model's context (CLEAN-124). */
  maxToolOutputChars: number
  /** Most serialized history handed to the model in one call (CLEAN-124). */
  contextBudgetChars: number
}

export const LOOP_DEFAULTS: ILoopConfig = {
  maxIterations: 25,
  maxToolOutputChars: 16_000,
  contextBudgetChars: 400_000,
  maxConsecutiveErrors: 3,
  maxContinuations: 4,
  toolTimeout: 120_000,
}

/**
 * One source an answer may cite (CLEAN-138) — the shape a tool result
 * declares, the turn registry numbers, and the `sources` event carries to
 * the hub. Only what a reader may see: an id and a name, or a URL and a
 * title. No excerpts, scores or storage paths. Contract: ranch
 * `specs/020-chat-sources/contracts/sources.md` §1.
 */
export type ISource =
  | { kind: "knowledge"; id: string; name: string; knowledgeId: string; knowledgeName: string | null }
  | { kind: "web"; url: string; title: string | null }

/**
 * What the hub relays to the browser for one cited source (contract §5).
 * The runtime never builds this — it is here so the two halves of the wire
 * sit next to each other: `id` and `knowledgeId` stop at the hub, the client
 * addresses a source by `(messageId, n)`, and `canOpen` is the hub's policy
 * answer computed on relay, never stored.
 */
export interface ISourceFrameEntry {
  n: number
  kind: ISource["kind"]
  name: string
  url?: string
  knowledgeName?: string | null
  canOpen: boolean
  myRating?: 1 | -1
}

export interface ILoopContext {
  task: Task
  sessionId: string
  agentDir: string
  from: string
  /** The person behind the message, apart from `from` (CLEAN-80); see Message.user. */
  user?: { id: string; email?: string }
  /** Browser origin of the sending socket (CLEAN-120); see Message.origin. */
  origin?: string
  channel: string
  isInternal: boolean
  systemPrompt: string
  history: Event[]
  tools: Tool[]
  /** Resolves to the wire message id when the channel mints one (bridle). */
  send: (text: string, parts?: MessagePart[]) => Promise<string | void>
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
  /**
   * Whether this turn's client can draw citations (CLEAN-138): it advertised
   * the `sources` capability. True → tool results tell the model which
   * numbers it may cite and every bubble is validated and renumbered. False
   * (the default) → nothing is added and any `[^n]` the model writes anyway
   * is stripped from the outgoing text, because there is nothing to show.
   */
  citeSources?: boolean
  /**
   * Best-effort publish of one bubble's validated citations: the corrected
   * text and the sources it cites, in citation order. Wired only when
   * `citeSources` is on; called only for bubbles that cite something.
   */
  sendSources?: (messageId: string, text: string, sources: ISource[]) => void
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
