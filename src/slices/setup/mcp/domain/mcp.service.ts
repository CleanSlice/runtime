import type { Tool } from "../../../agent/tool"
import { IMcpGateway } from "./mcp.gateway"
import type { IMcpConnectedEvent, IMcpLoadOptions, IMcpServerConfig } from "./mcp.types"
import { McpFetcher } from "./mcp.fetcher"
import type { IActor } from "./actor"
import { createLogger } from "../../logger"
import { nextDelayMs } from "./retryPolicy"
import { nextPhaseCheckAt, phaseOf, startGraceMs, type IToolState, type ToolPhaseTypes } from "./toolState"

const log = createLogger("mcp")

/**
 * Orchestrates the boot-time MCP load:
 *  1. parses the platform-managed list (decoded from MCP_SERVERS_B64 env)
 *  2. merges with config-file entries (env wins on `name` collision)
 *  3. opens a client for each enabled entry
 *  4. returns the combined Tool[] for ToolGateway to register
 *
 * Failures are non-fatal: a bad MCP server logs a warning and is skipped,
 * the rest still load. Boot never aborts because of MCP issues.
 *
 * After boot it also applies `mcp_connected` (CLEAN-79): a login that just
 * landed brings the person's client up in the running session and, the
 * first time, swaps that server's connect-only tool for its real tools in
 * the live registry — no restart.
 *
 * And it keeps trying the servers that did not answer (CLEAN-245): one timer
 * per missing server, a growing pause between attempts, for as long as the
 * agent runs. A server that answers gets its tools put into the live
 * registry the same way a login does.
 */
export class McpService {
  /** The array the runtime reads on every message; null until `bind`. */
  private registry: Tool[] | null = null
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private phaseTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private stateListeners = new Set<(state: IToolState) => void>()
  /** The waiting limit of a start counts from here. */
  private readonly startedAt: number
  private phase: ToolPhaseTypes = "ready"
  private phaseSince: number
  private stopped = false

  constructor(
    private gateway: IMcpGateway,
    private fetcher: McpFetcher,
    /** `setTimeout` in production; a spec passes its own clock. */
    private clock: IMcpClock = realClock,
  ) {
    this.startedAt = clock.now()
    this.phaseSince = this.startedAt
  }

  /**
   * Hand over the live registry and start watching the servers. From here a
   * server that is not connected is tried again by itself, and its tools
   * land in `registry` when it answers.
   */
  bind(registry: Tool[]): void {
    this.registry = registry
    this.unsubscribe?.()
    this.unsubscribe = this.gateway.onChange(() => this.onGatewayChange())
    this.onGatewayChange()
  }

  /** What the tool servers look like now, and the one word for it. */
  state(): IToolState {
    const servers = this.gateway.status()
    this.refreshPhase(servers)
    return {
      phase: this.phase,
      since: new Date(this.phaseSince).toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      servers,
    }
  }

  /** Called whenever `state()` would answer differently. Returns the unsubscribe. */
  onState(listener: (state: IToolState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /**
   * Before a turn: give the missing servers one attempt, and wait for it at
   * most `budgetMs`. A person who writes the second the server is back
   * should not be told it is missing because the timer had 40 s to go.
   */
  async settle(budgetMs: number): Promise<void> {
    const missing = this.gateway.status().filter((s) => s.state === "retrying")
    if (missing.length === 0 || this.stopped) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<void>((resolve) => {
      timer = this.clock.set(resolve, budgetMs)
    })
    const attempts = Promise.all(missing.map((s) => this.tryNow(s.name))).then(() => undefined)
    await Promise.race([attempts, budget])
    if (timer !== undefined) this.clock.clear(timer)
  }

  async loadAll(opts: IMcpLoadOptions): Promise<Tool[]> {
    const fromEnv = this.fetcher.fromEnv(opts.fromEnv)
    const merged = this.mergeByName(opts.fromConfig, fromEnv)
    if (merged.length === 0) {
      log.info("no servers configured")
      return []
    }
    log.info(
      `connecting to ${merged.length} server(s): ${merged.map((m) => m.name).join(", ")}`,
    )
    // Together, not one after another: a server that swallows packets holds
    // its attempt for the whole connect timeout, and the others need not wait.
    const all = (await Promise.all(merged.map((cfg) => this.gateway.connect(cfg)))).flat()
    log.info(`total ${all.length} tools registered from MCP servers`)
    return all
  }

  /**
   * Apply a login to the running session. `registry` is the live tool list
   * the runtime reads on every message (the same array `loadAll` fed), so
   * swapping entries in place is what makes the tools appear mid-session.
   * Returns how many tools are live for that server afterwards, or null
   * when the event was not for a server this runtime runs.
   */
  async handleConnected(event: IMcpConnectedEvent, registry: Tool[]): Promise<number | null> {
    const result = await this.gateway.reconnect(event.serverId, event.subject)
    if (!result) {
      log.debug(`mcp_connected for ${event.server} ignored — not one of this agent's servers`)
      return null
    }
    if (!result.tools) return countFor(registry, result.serverName)
    swapServerTools(registry, result.serverName, result.tools)
    return countFor(registry, result.serverName)
  }

  /** The tools of one turn, narrowed to what per-caller servers list for its actor (CLEAN-232). */
  scopeTools(tools: Tool[], actor: IActor): Promise<Tool[]> {
    return this.gateway.scopeTools(tools, actor)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const timer of this.timers.values()) this.clock.clear(timer)
    this.timers.clear()
    if (this.phaseTimer) this.clock.clear(this.phaseTimer)
    this.phaseTimer = null
    this.stateListeners.clear()
    await this.gateway.closeAll()
  }

  /** One attempt at `name`; on success its tools replace what the registry held for it. */
  private async tryNow(name: string): Promise<void> {
    const tools = await this.gateway.attempt(name).catch((err) => {
      log.warn(`${name}: attempt failed — ${(err as Error).message}`)
      return null
    })
    if (!tools || this.stopped || !this.registry) return
    swapServerTools(this.registry, name, tools)
    log.info(`${name}: ${countFor(this.registry, name)} tools are live`)
  }

  /** A server changed: keep exactly one timer per server still being tried, and tell who listens. */
  private onGatewayChange(): void {
    if (this.stopped) return
    const servers = this.gateway.status()
    const retrying = new Set(servers.filter((s) => s.state === "retrying").map((s) => s.name))
    for (const [name, timer] of this.timers) {
      if (retrying.has(name)) continue
      this.clock.clear(timer)
      this.timers.delete(name)
    }
    for (const server of servers) {
      if (server.state !== "retrying" || this.timers.has(server.name)) continue
      this.schedule(server.name, server.attempts)
    }
    this.refreshPhase(servers)
    this.emitState()
  }

  private schedule(name: string, attempts: number): void {
    const timer = this.clock.set(() => {
      this.timers.delete(name)
      void this.tryNow(name).then(() => {
        // A failure changed the attempt count and came through `onChange`;
        // this covers an attempt that ended without one (shared, or thrown).
        if (this.stopped || this.timers.has(name)) return
        const still = this.gateway.status().find((s) => s.name === name)
        if (still?.state === "retrying") this.schedule(name, still.attempts)
      })
    }, nextDelayMs(attempts))
    this.timers.set(name, timer)
  }

  /** Recompute the phase and arm the one timer for the moment it changes by time alone. */
  private refreshPhase(servers = this.gateway.status()): boolean {
    const now = this.clock.now()
    const grace = startGraceMs()
    const next = phaseOf(servers, this.startedAt, now, grace)
    const changed = next !== this.phase
    if (changed) {
      this.phase = next
      this.phaseSince = now
    }
    if (this.phaseTimer) this.clock.clear(this.phaseTimer)
    this.phaseTimer = null
    const at = this.stopped ? null : nextPhaseCheckAt(servers, this.startedAt, now, grace)
    if (at !== null) {
      this.phaseTimer = this.clock.set(() => {
        this.phaseTimer = null
        if (this.refreshPhase()) this.emitState()
      }, Math.max(at - now, 0) + 1)
    }
    return changed
  }

  private emitState(): void {
    if (this.stateListeners.size === 0) return
    const state = this.state()
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch (err) {
        log.warn(`tool state listener failed — ${(err as Error).message}`)
      }
    }
  }

  /**
   * Merge by `name`. Env entries overwrite file entries — the orchestrator
   * is the managed source of truth, the config file is for local additions.
   * Logs overrides so it's visible when something gets shadowed.
   */
  private mergeByName(
    local: IMcpServerConfig[],
    env: IMcpServerConfig[],
  ): IMcpServerConfig[] {
    const map = new Map<string, IMcpServerConfig>()
    for (const m of local) map.set(m.name, m)
    for (const m of env) {
      if (map.has(m.name)) {
        log.info(`${m.name}: env entry overrides config-file entry`)
      }
      map.set(m.name, m)
    }
    return [...map.values()]
  }
}

/** The timers the service sets, so a spec can run them by hand. */
export interface IMcpClock {
  now(): number
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
}

const realClock: IMcpClock = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    // A pause between attempts must not keep a stopping process alive.
    timer.unref?.()
    return timer
  },
  clear: (timer) => clearTimeout(timer),
}

const prefixOf = (serverName: string): string => `${serverName}__`

/**
 * Replace every `${serverName}__*` tool in the live registry with `next`, in
 * place. In place matters: the runtime and the loop hold this very array,
 * and a new array would be one they never see.
 */
export function swapServerTools(registry: Tool[], serverName: string, next: Tool[]): void {
  const prefix = prefixOf(serverName)
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i]!.name.startsWith(prefix)) registry.splice(i, 1)
  }
  registry.push(...next)
}

/** Tools live for a server, the connect tool excluded. */
export function countFor(registry: Tool[], serverName: string): number {
  const prefix = prefixOf(serverName)
  const connect = `${serverName}__connect`
  return registry.filter((t) => t.name.startsWith(prefix) && t.name !== connect).length
}
