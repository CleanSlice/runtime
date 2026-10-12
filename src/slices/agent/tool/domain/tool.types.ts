import type { ZodSchema } from "zod"
import type { IAgentConfig } from "../../../runtime/init"
import type { AccessModule } from "../../../bot/access/access.module"
import type { ChannelModule } from "../../../setup/channel/channel.module"
import type { MessagePart } from "../../../setup/channel/domain/channel.types"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { UsageModule } from "../../../bot/usage/usage.module"
import type { LastTurnStatsTracker } from "../../../runtime/loop/domain/last-turn-stats.tracker"
import type { ISource } from "../../../runtime/loop/domain/loop.types"
import type { GuardModule } from "../../guard/guard.module"
import type { SkillModule } from "../../skill/skill.module"
import type { InstinctModule } from "../../instinct/instinct.module"
import type { IPromptBreakdown } from "../../agent/domain/agent.types"

export type ToolEffect = "read" | "write"

/** The effect of one call: `effectOf` when the tool has it, else `effect`, else `write`. */
export function effectOfCall(tool: Tool, params: unknown): ToolEffect {
  if (tool.effectOf) {
    try {
      return tool.effectOf(params)
    } catch {
      return "write"
    }
  }
  return tool.effect ?? "write"
}

export interface ToolContext {
  sessionId: string
  agentDir: string
  from?: string   // chat id (e.g. Telegram user id)
  channel?: string
  /**
   * The person behind the message, apart from the channel (CLEAN-80): the
   * console login the bridle hub attached (id = JWT sub, email for display).
   * Owners and admins share one `from` ("admin") but each carries their own
   * id here, so per-person state — an MCP OAuth token — keys on it. Absent
   * on channels without the concept and for share/anonymous visitors, whose
   * `from` is already theirs alone.
   */
  user?: { id: string; email?: string }
  /**
   * The browser origin the person is sitting in (CLEAN-120), forwarded by
   * the bridle hub from the socket's handshake. A tool that sends someone
   * away — an OAuth login — uses it to bring them back to the same console.
   * Absent on other channels.
   */
  origin?: string
  // `parts` is the rich-content escape hatch: pass [{type:"image", base64,
  // mediaType}, ...] to attach images/files to the same message. Channels
  // that don't support rich parts (telegram via this hook — telegram has
  // its own sendPhoto path) fall back to text-only.
  send: (text: string, parts?: MessagePart[]) => Promise<void>
  agentConfig?: IAgentConfig
  reloadSkills?: () => Promise<void>  // hot-reload skills after skill_write
  access?: AccessModule
  isAdmin?: boolean
  channels?: ChannelModule  // live channel registry — drives channel_* tools
  // Operational modules — wired by the loop so resource_status can inspect
  // LLM credential state, daily usage totals, and the previous-turn stats.
  llm?: LlmModule
  usage?: UsageModule
  lastTurnStats?: LastTurnStatsTracker
  /** Guardrails — lets `agent_status` report the rule set and recent firings (CLEAN-150). */
  guard?: GuardModule
  /** Skills — `skill_load` pulls a skill into the session for a few turns (CLEAN-150 US2). */
  skills?: SkillModule
  /** Learned behaviours — `agent_status.learned` (CLEAN-150 US3). */
  instincts?: InstinctModule
  /** This session's turn number, for skill retention. */
  turn?: number
  /** The system-prompt accounting of this turn — `agent_status.context`. */
  promptBreakdown?: IPromptBreakdown
  /** This session's most recent compaction and why it ran (CLEAN-150 US4). */
  lastCompaction?: { reason: string; ts: number }
  /**
   * Tools visible to THIS session's caller (admin-only tools are already
   * filtered out upstream for non-admins). Lets introspection tools like
   * agent_status report what the current user can actually invoke.
   */
  tools?: Tool[]
}

export interface Tool {
  name: string
  description: string
  /**
   * Zod schema describing the tool's params. Used both for runtime validation
   * (tool.execute receives `unknown`) and as the source for the LLM-facing
   * JSON Schema via `zodToJsonSchema`.
   *
   * For tools whose schema is already JSON Schema (e.g. MCP-imported tools),
   * use `z.any()` here and provide the JSON Schema via `inputSchema` — that
   * field takes precedence when serializing for the LLM.
   */
  schema: ZodSchema
  /**
   * Optional pre-built JSON Schema for the LLM. When set, takes precedence
   * over `zodToJsonSchema(schema)`. Use this when the schema comes from an
   * external source (MCP server, OpenAPI spec) and round-tripping it through
   * Zod would lose information.
   */
  inputSchema?: Record<string, unknown>
  /** When true, only admin users can call this tool. Mutating tools should be marked admin-only. */
  adminOnly?: boolean
  /**
   * Whether a call changes anything outside the conversation. Unset means
   * `write`: an unannotated tool is verified rather than skipped. Tools whose
   * effect depends on the call (`file` read/write, `http` GET/POST) implement
   * `effectOf` instead and leave this unset.
   */
  effect?: ToolEffect
  /** Per-call effect for tools whose params decide it; wins over `effect`. */
  effectOf?(params: unknown): ToolEffect
  /**
   * Visitor-facing thinking-step label for a call with these params — a
   * short, safe phrase like "Read SOUL.md" or "Run bun". This rides the
   * un-gated `thinking` wire event to end users, so return a curated
   * extract only (basenames, hostnames, verbs) — NEVER raw params, full
   * paths, commands, or headers. Returning undefined (or throwing) falls
   * back to the humanized tool name.
   */
  stepLabel?(params: unknown): string | undefined
  /**
   * The sources this call consulted, read off its RAW result (before any
   * context-budget cap), so an answer built on them can cite them
   * (CLEAN-138). Built-ins that fetch the web implement it; tools whose
   * result already carries a top-level `sources` array in the contract
   * shape need not — the loop reads that key itself. Entries hold only
   * what a reader may see (id + name, or url + title), never excerpts or
   * storage paths. Shape and rules: ranch
   * `specs/020-chat-sources/contracts/sources.md` §1–2.
   */
  sources?(params: unknown, result: unknown): ISource[]
  execute(params: unknown, ctx: ToolContext): Promise<unknown>
}
