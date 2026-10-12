import type { MemoryLimits, MemoryReviewConfig } from "../../../agent/memory/domain/memory.types"
import { DEFAULT_MEMORY_LIMITS, DEFAULT_MEMORY_REVIEW } from "../../../agent/memory/domain/memory.types"

import type { IInstinctConfig } from "../../../agent/instinct/domain/instinct.types"
import { DEFAULT_INSTINCT_CONFIG } from "../../../agent/instinct/domain/instinct.types"

export type { IInstinctConfig }
export { DEFAULT_INSTINCT_CONFIG }

/** Runtime configuration loaded from agent.config.json */
export interface IAgentConfig {
  maxIterations: number
  taskLabelLength: number
  maxTokens: number

  /** Access control strategy. Defaults to "approval". Runtime override in data/access.json takes precedence. */
  accessStrategy?: "open" | "public" | "allowlist" | "code" | "approval"

  /** For "allowlist" strategy: list of allowed Telegram user IDs */
  allowlist?: string[]

  /** For "code" strategy: the secret code users must send */
  accessCode?: string

  heartbeat: {
    intervalMin: number
  }

  session: {
    compactionThreshold: number
    /**
     * Compact when the serialized session exceeds this many bytes, even if the
     * event COUNT is still under compactionThreshold. Guards against a few huge
     * tool_result payloads overflowing the model's context window.
     */
    compactionBytesThreshold: number
    recentKeep: number
    /**
     * The most serialized history (chars) handed to the model in one call,
     * whatever compaction did or failed to do. Oldest events are left out
     * first; a leading summary and the latest user message always stay
     * (CLEAN-124). ~4 chars per token: 400 000 is ~100k tokens.
     */
    contextBudgetChars: number
    /**
     * Sessions idle for this many minutes and over the compaction threshold
     * are compacted by the heartbeat sweep (CLEAN-150 US4). 0 disables.
     */
    idleCompactMin: number
    /**
     * Size-triggered compaction may interrupt a task in flight only once the
     * serialized session passes this percentage of contextBudgetChars.
     * Below it, compaction waits for the task boundary.
     */
    hardLimitPct: number
  }

  /**
   * Memory subsystem configuration.
   * - `limits`: per-file character limits; oldest content is truncated from
   *   the top when a file exceeds its limit. Bounds system-prompt size.
   * - `review`: background self-improvement review — every N turns, promote
   *   durable facts from the conversation into MEMORY.md.
   * - `instincts`: confidence-weighted learned behaviours (CLEAN-150 US3).
   */
  memory: {
    limits: MemoryLimits
    review: MemoryReviewConfig
    instincts: IInstinctConfig
  }

  /**
   * Character budget for the always-on system prompt, per section. The
   * runtime reports the actual split per turn (`/context`, `agent_status`)
   * and warns at start-up when a section overflows (CLEAN-150 US2).
   */
  contextBudget: {
    total: number
    sections: {
      soul: number
      tooling: number
      skillsCatalog: number
      memory: number
      dailyNotes: number
      alwaysSkills: number
      instincts: number
    }
  }

  skills: {
    /**
     * How a skill gets into a turn. `model`: the agent calls `skill_load`
     * when a catalogue description matches. `keyword`: the legacy word-overlap
     * matcher — kept for one release as a fallback.
     */
    selection: "model" | "keyword"
    /** A loaded skill stays in the conversation for this many turns after its last use. */
    retainTurns: number
  }

  /** Guardrails around tool calls (CLEAN-150 US1). Rules live in `.agent/rules/`. */
  guard: {
    /** Upper bound for a `record` rule's handler; slower observers are abandoned. */
    observerTimeoutMs: number
    /** Tool-call record file, relative to the agent dir. */
    recordFile: string
    /** Rotate the record file once it passes this size. */
    recordMaxBytes: number
  }

  /** Post-turn check of completion claims against mutating tool outcomes (CLEAN-150 US5). */
  verification: {
    enabled: boolean
    timeoutMs: number
  }

  s3: {
    /**
     * Optional periodic full-sweep backup. 0 disables it.
     * Sync is event-driven by default (fs.watch + diff).
     */
    syncIntervalSec: number
    /** Debounce window for fs.watch flushes, in ms. Default: 30000. */
    watcherDebounceMs?: number
  }

  tools: {
    spawnAgent: {
      timeoutMin: number
      outputLimit: number
    }
    browser: {
      outputLimit: number
    }
    webFetch: {
      maxChars: number
    }
    /**
     * Cap on the string fields of tool_call / tool_result events handed to
     * the model. The full payload stays on disk; only the in-memory copy is
     * trimmed. Must clear a `query_attachment` read — the tool exists so the
     * model can pull exact cells out of a spreadsheet, and a cap below its
     * result size hands back the same guesswork the preview already forced.
     */
    maxOutputChars: number
    /**
     * Tools whose full description is always in the prompt. Every other tool
     * gets a one-line stub and `tool_describe` on demand (CLEAN-150 US2).
     */
    coreCatalogue: string[]
    /** `delegate_task` worker budgets (CLEAN-150 US6). */
    delegate: {
      timeoutMs: number
      maxParallel: number
      summaryChars: number
      /** Let workers call write-effect tools. Default false: workers observe and report, the parent acts. */
      allowWrite: boolean
    }
  }

  /** Caps on user message text reaching the model. See messageTruncation.ts. */
  message: {
    /** Ordinary user messages. */
    maxChars: number
    /** User messages carrying an attachment — the API inlines a preview. */
    maxCharsWithAttachments: number
  }

  /** Words/phrases that immediately cancel all running tasks. Case-insensitive. */
  stopPhrases: string[]

  /**
   * Files overwritten from .agent.example on every restart.
   * Only files listed here are touched — everything else is preserved.
   * Default: ["SOUL.md"]
   */
  managedFiles: string[]

  /**
   * Whether to sync skills from .agent.example on restart.
   * Only overwrites skills that exist in both .agent and .agent.example.
   * Skills only in .agent (user-created) are never deleted.
   * Default: true
   */
  syncSkills: boolean

  /**
   * MCP servers to connect to at runtime. Loaded by the McpModule on boot:
   * each entry becomes a connected MCP client whose tools are merged into
   * the global ToolGateway, so the LLM sees them alongside built-in tools.
   *
   * Sources, in priority order:
   *  1. `MCP_SERVERS_B64` env — base64(JSON array), populated by the deploy
   *     pipeline of whatever orchestrator hosts the runtime (managed source
   *     of truth). Base64 because the value is injected into a YAML manifest.
   *  2. This `mcps` field — used standalone, or merged with the env list
   *     (env entries override file entries with the same `name`).
   *
   * Disabled servers can be filtered out by setting `enabled: false`.
   */
  mcps?: IMcpServerConfig[]
}

/**
 * Connection config for a single MCP server. Same shape is used for both
 * `agent.config.json#mcps` and `MCP_SERVERS_B64` env values.
 */
export interface IMcpServerConfig {
  /**
   * Server id (Ranch McpServer.id). Optional for local/dev entries. For
   * `oauth` servers the runtime keys the per-agent token secret by it
   * (`mcpOauth:<id>`).
   */
  id?: string
  /** Unique key. MCP tools are namespaced as `${name}__${toolName}`. */
  name: string
  /**
   * Transport protocol. `streamableHttp` is the modern MCP HTTP transport,
   * `sse` is the legacy server-sent-events variant. `stdio` spawns a
   * subprocess — useful for local dev / unmanaged MCPs in standalone mode.
   */
  transport: "streamableHttp" | "sse" | "stdio"

  /** Endpoint URL (for streamableHttp / sse). */
  url?: string

  /** Command + args (for stdio transport only). */
  command?: string
  args?: string[]

  /**
   * How to authenticate the connection. `bearer` adds an `Authorization:
   * Bearer <authValue>` header. `header` interprets `authValue` as a literal
   * `Header-Name: value` line. `none` sends no auth header. `oauth` holds no
   * static credential — the runtime refreshes its own bearer from the
   * per-agent token secret (`mcpOauth:<id>`), obtained via the in-chat Connect
   * flow. See CLEAN-75.
   */
  authType?: "none" | "bearer" | "header" | "oauth"
  authValue?: string | null

  /** Default true. Set to false to keep the entry registered but skip connect. */
  enabled?: boolean
}

/** Required subdirectories inside the agent directory */
export const AGENT_SUBDIRS = ["data", "sessions", "memory", "skills", "workspace"] as const

/**
 * Default list of managed files — synced from .agent.example on startup.
 * Can be overridden via agent.config.json `managedFiles` field.
 */
export const DEFAULT_MANAGED_FILES = ["SOUL.md"] as const

/** Default config values — used when agent.config.json is missing or partial */
export const AGENT_CONFIG_DEFAULTS: IAgentConfig = {
  maxIterations: 25,
  taskLabelLength: 60,
  maxTokens: 16384,

  heartbeat: {
    intervalMin: 30,
  },

  session: {
    compactionThreshold: 60,
    compactionBytesThreshold: 200_000,
    recentKeep: 20,
    contextBudgetChars: 400_000,
    idleCompactMin: 30,
    hardLimitPct: 90,
  },

  memory: {
    limits: { ...DEFAULT_MEMORY_LIMITS },
    review: { ...DEFAULT_MEMORY_REVIEW },
    instincts: structuredClone(DEFAULT_INSTINCT_CONFIG),
  },

  contextBudget: {
    total: 48_000,
    sections: {
      soul: DEFAULT_MEMORY_LIMITS.soul,
      tooling: 6000,
      skillsCatalog: 3000,
      memory: DEFAULT_MEMORY_LIMITS.memory,
      dailyNotes: DEFAULT_MEMORY_LIMITS.daily * 2,
      alwaysSkills: 12_000,
      instincts: 2500,
    },
  },

  skills: {
    selection: "model",
    retainTurns: 3,
  },

  guard: {
    observerTimeoutMs: 2000,
    recordFile: "data/toolcalls.jsonl",
    recordMaxBytes: 10 * 1024 * 1024,
  },

  verification: {
    enabled: true,
    timeoutMs: 8000,
  },

  s3: {
    syncIntervalSec: 0,
    watcherDebounceMs: 30_000,
  },

  tools: {
    spawnAgent: {
      timeoutMin: 5,
      outputLimit: 4000,
    },
    browser: {
      outputLimit: 5000,
    },
    webFetch: {
      maxChars: 8000,
    },
    maxOutputChars: 16_000,
    coreCatalogue: ["exec", "file", "http", "web_fetch", "memory_search", "secret_get", "skill_load", "tool_describe"],
    delegate: {
      timeoutMs: 300_000,
      maxParallel: 5,
      summaryChars: 4000,
      allowWrite: false,
    },
  },

  message: {
    maxChars: 4000,
    // Clears the API's 40 000-char spreadsheet preview budget with room for
    // the person's own text and the block's header.
    maxCharsWithAttachments: 48_000,
  },

  stopPhrases: [
    "/stop",
    "stop", "abort", "cancel",
    "halt", "enough", "quit",
  ],

  managedFiles: [...DEFAULT_MANAGED_FILES],
  syncSkills: true,
}
