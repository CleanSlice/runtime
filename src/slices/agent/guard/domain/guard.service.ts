import type { IGuardGateway } from "./guard.gateway"
import type {
  IAfterMeta, IAfterVerdict, IBeforeVerdict, IGuardCall, IRule, IRuleFile, IRuleFiringCount, IRuleMatch,
  IToolCallRecord, RuleAction, RuleEvent,
} from "./guard.types"
import { argMatches, matchesTool, resultMatches } from "./rule.matcher"
import { redact } from "../../../setup/logger/redact"
import { createLogger } from "../../../setup/logger"

const log = createLogger("guard")

const ID_RE = /^[a-z0-9-]{2,64}$/
const EVENTS: RuleEvent[] = ["before", "after"]
const ACTIONS: RuleAction[] = ["block", "redact", "record"]
/** Firings older than this are dropped from the in-memory counter. */
const FIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The opening of a credential that `redact()` would mask once complete, at
 * the very end of a streamed text. Mirrors the heads of SECRET_PATTERNS in
 * setup/logger/redact.ts; a masked token ("sk-ant…op") never matches because
 * the mask ends in the token's last two characters, not its head.
 */
const PARTIAL_SECRET_TAIL_RE = /(sk-[\w-]{0,40}|gh[pousr]_\w{0,40}|Bearer\s+[\w.-]{0,40}|eyJ[\w-]{0,60}(\.[\w-]{0,60}){0,2}|AKIA\w{0,20}|xox[baprs]-[\w-]{0,40}|\b\d{8,10}:[\w-]{0,40})$/i

/** A rule set that cannot be used: which file, and what is wrong with it. */
export class GuardLoadError extends Error {
  constructor(public readonly problems: Array<{ file: string; problem: string }>) {
    super(problems.map(p => `${p.file}: ${p.problem}`).join("; "))
    this.name = "GuardLoadError"
  }
}

/** Validate one rule file into a rule. Throws with the offending field named. */
export function parseRule(file: IRuleFile): IRule {
  if (file.error) throw new Error(file.error)
  const d = file.data
  const id = d.id
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`id must match ${ID_RE} (got ${JSON.stringify(id)})`)
  const event = d.event
  if (!EVENTS.includes(event as RuleEvent)) throw new Error(`event must be one of ${EVENTS.join(", ")}`)
  const action = d.action
  if (!ACTIONS.includes(action as RuleAction)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`)
  const match = d.match
  if (!match || typeof match !== "object") throw new Error("match is required")
  const m = match as Record<string, unknown>
  if (typeof m.tool !== "string" || !m.tool.trim()) throw new Error("match.tool must be a non-empty glob")
  const parsed: IRuleMatch = { tool: m.tool.trim() }
  if (m.arg !== undefined) {
    if (event !== "before") throw new Error("match.arg is only valid with event: before")
    const a = m.arg as Record<string, unknown>
    if (!a || typeof a.path !== "string" || typeof a.pattern !== "string") throw new Error("match.arg needs path and pattern")
    if (!a.path.startsWith("$")) throw new Error("match.arg.path must start with $")
    compileOrThrow(a.pattern, "match.arg.pattern")
    parsed.arg = { path: a.path, pattern: a.pattern }
  }
  if (m.result !== undefined) {
    if (event !== "after") throw new Error("match.result is only valid with event: after")
    if (typeof m.result !== "string") throw new Error("match.result must be a regex string")
    compileOrThrow(m.result, "match.result")
    parsed.result = m.result
  }
  return {
    id,
    event: event as RuleEvent,
    match: parsed,
    action: action as RuleAction,
    enabled: d.enabled === undefined ? true : d.enabled === true,
    // Only the platform can protect a rule; an agent file saying so is ignored.
    protected: file.source === "baseline" && d.protected === true,
    source: file.source,
    reason: file.body.trim(),
    file: file.file,
  }
}

function compileOrThrow(pattern: string, field: string): void {
  try {
    new RegExp(pattern)
  } catch (err) {
    throw new Error(`${field} is not a valid regex: ${(err as Error).message}`)
  }
}

interface IGuardOptions {
  observerTimeoutMs: number
}

/**
 * Deterministic guardrails around every tool call (CLEAN-150 US1).
 *
 * `before` runs synchronously ahead of the tool: a matching `block` rule
 * stops the call, a `redact` rule masks credential-shaped strings in the
 * params. `after` runs on the result: `redact` masks, `record` appends a
 * tool-call record through the gateway. Outcomes compose strictest-first
 * (block > redact > record).
 *
 * Fail semantics: `load()` is all-or-nothing — one bad file and the previous
 * rule set stays in force while the error is reported. Until the first
 * successful load (or after `markFailed`) every call is blocked. Guard rules
 * fail closed (an evaluator exception blocks); observers fail open (logged
 * once per rule, bounded by `observerTimeoutMs`, never change the result).
 */
export class GuardService {
  private rules: IRule[] = []
  private loaded = false
  private loadError: string | undefined
  private firings = new Map<string, number[]>()
  private failures = new Map<string, number>()

  constructor(private gateway: IGuardGateway, private opts: IGuardOptions) {}

  /** Read and validate every rule file; replaces the active set only when all of them pass. */
  async load(): Promise<void> {
    const files = this.gateway.loadRuleFiles()
    const problems: Array<{ file: string; problem: string }> = []
    const next = new Map<string, IRule>()
    for (const file of files) {
      let rule: IRule
      try {
        rule = parseRule(file)
      } catch (err) {
        problems.push({ file: file.file, problem: (err as Error).message })
        continue
      }
      const existing = next.get(rule.id)
      if (existing?.protected && rule.source === "agent") {
        problems.push({ file: file.file, problem: `rule "${rule.id}" is protected by the platform and cannot be overridden` })
        continue
      }
      next.set(rule.id, rule)
    }
    if (problems.length > 0) throw new GuardLoadError(problems)
    this.rules = [...next.values()]
    this.loaded = true
    this.loadError = undefined
    log.info(`loaded ${this.rules.length} rules (${this.rules.filter(r => r.source === "baseline").length} baseline)`)
  }

  /** Record that rules could not be loaded; every call is blocked until `load()` succeeds. */
  markFailed(message: string): void {
    this.loaded = false
    this.loadError = message
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  get lastLoadError(): string | undefined {
    return this.loadError
  }

  listRules(): IRule[] {
    return [...this.rules]
  }

  /** Decide whether a call may run, and with which params. */
  before(call: IGuardCall): IBeforeVerdict {
    if (!this.loaded) {
      return { kind: "block", ruleId: "rules-not-loaded", reason: `rules failed to load: ${this.loadError ?? "no rule set loaded"}` }
    }
    let params = call.params
    const fired: string[] = []
    for (const rule of this.active("before")) {
      let hit: boolean
      try {
        hit = matchesTool(rule.match.tool, call.tool) && (!rule.match.arg || argMatches(rule.match.arg, params, call.agentDir))
      } catch (err) {
        if (rule.action === "record") {
          this.observerFailed(rule.id, err)
          continue
        }
        this.fire(rule.id)
        return { kind: "block", ruleId: rule.id, reason: `rule evaluation failed: ${(err as Error).message}` }
      }
      if (!hit) continue
      if (rule.action === "block") {
        this.fire(rule.id)
        return { kind: "block", ruleId: rule.id, reason: rule.reason || "blocked by policy" }
      }
      fired.push(rule.id)
      this.fire(rule.id)
      if (rule.action === "redact") params = redactDeep(params).value
    }
    return { kind: "allow", params, rulesFired: fired }
  }

  /** Transform the result and run observers. Never throws. */
  async after(call: IGuardCall, result: unknown, meta: IAfterMeta): Promise<IAfterVerdict> {
    let out = result
    let redacted = false
    const fired = [...meta.rulesFired]
    const observers: IRule[] = []
    for (const rule of this.active("after")) {
      if (!matchesTool(rule.match.tool, call.tool)) continue
      if (rule.action === "record") {
        observers.push(rule)
        continue
      }
      try {
        if (rule.match.result && !resultMatches(rule.match.result, out)) continue
        const r = redactDeep(out)
        // A redact rule "fires" only when it changed something; a clean
        // result passing through it is not an event worth recording.
        if (!r.changed) continue
        out = r.value
        redacted = true
        fired.push(rule.id)
        this.fire(rule.id)
      } catch (err) {
        // A redaction we cannot evaluate must not leak: withhold the result.
        this.fire(rule.id)
        out = { error: `rule ${rule.id} could not evaluate the result; it was withheld (${(err as Error).message})` }
        redacted = true
        fired.push(rule.id)
      }
    }
    if (observers.length > 0) {
      const record: IToolCallRecord = {
        ts: Date.now(),
        sessionId: call.sessionId,
        turnId: call.turnId,
        tool: call.tool,
        outcome: meta.outcome,
        durationMs: meta.durationMs,
        paramsChars: sizeOf(call.params),
        resultChars: sizeOf(out),
        rulesFired: [...fired, ...observers.map(o => o.id)],
        redacted,
        effect: call.effect,
      }
      for (const o of observers) this.fire(o.id)
      await this.observe(observers, record)
    }
    return { result: out, redacted, rulesFired: fired.concat(observers.map(o => o.id)) }
  }

  /** Mask credentials in text the agent is about to send, when a wildcard redact rule is active. */
  redactOutgoing(text: string): string {
    return this.outgoingRedactionActive() ? redact(text) : text
  }

  /**
   * Same, for a reply still being streamed: the accumulated text is masked,
   * and a tail that looks like the start of a credential is held back until
   * more arrives — otherwise the first characters of a token would be on
   * screen before the pattern is long enough to recognise.
   */
  redactStreaming(accumulated: string): string {
    if (!this.outgoingRedactionActive()) return accumulated
    const masked = redact(accumulated)
    const partial = masked.match(PARTIAL_SECRET_TAIL_RE)
    return partial ? masked.slice(0, partial.index) : masked
  }

  private outgoingRedactionActive(): boolean {
    return this.active("after").some(r => r.action === "redact" && !r.match.result && matchesTool(r.match.tool, "*"))
  }

  /** How often each rule fired within the last `hours`, most frequent first. */
  recentFirings(hours: number): IRuleFiringCount[] {
    const since = Date.now() - hours * 60 * 60 * 1000
    const counts: IRuleFiringCount[] = []
    for (const [id, stamps] of this.firings) {
      const times = stamps.filter(ts => ts >= since).length
      if (times > 0) counts.push({ id, times })
    }
    return counts.sort((a, b) => b.times - a.times || a.id.localeCompare(b.id))
  }

  /** Observer failures per rule id since start — for `/rules`. */
  observerFailures(): Record<string, number> {
    return Object.fromEntries(this.failures)
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private active(event: RuleEvent): IRule[] {
    return this.rules.filter(r => r.enabled && r.event === event)
  }

  private fire(id: string): void {
    const now = Date.now()
    const stamps = (this.firings.get(id) ?? []).filter(ts => now - ts < FIRING_WINDOW_MS)
    stamps.push(now)
    this.firings.set(id, stamps)
  }

  private async observe(observers: IRule[], record: IToolCallRecord): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">(res => { timer = setTimeout(() => res("timeout"), this.opts.observerTimeoutMs) })
    const write = this.gateway.appendRecord(record).then(() => "ok" as const, (err: unknown) => {
      for (const o of observers) this.observerFailed(o.id, err)
      return "failed" as const
    })
    const outcome = await Promise.race([write, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === "timeout") {
      for (const o of observers) this.observerFailed(o.id, new Error(`observer exceeded ${this.opts.observerTimeoutMs}ms`))
    }
  }

  private observerFailed(id: string, err: unknown): void {
    const n = (this.failures.get(id) ?? 0) + 1
    this.failures.set(id, n)
    // Say it once per rule; the counter keeps the tally for /rules.
    if (n === 1) log.warn(`observer rule ${id} failed: ${(err as Error)?.message ?? String(err)} (further failures counted silently)`)
  }
}

/** Mask credential-shaped strings anywhere inside a value, reporting whether anything changed. */
export function redactDeep(value: unknown): { value: unknown; changed: boolean } {
  let changed = false
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v)
      if (r !== v) changed = true
      return r
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  const out = walk(value)
  return { value: changed ? out : value, changed }
}

function sizeOf(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === "string") return value.length
  try {
    return (JSON.stringify(value) ?? "").length
  } catch {
    return 0
  }
}
