import type { Event } from "../../../setup/event"
import type { ModelResponse } from "../../../setup/llm/domain/llm.types"
import { buildVerificationPrompt, parseVerification, type IToolOutcome } from "./prompts/verification.prompt"
import { createLogger } from "../../../setup/logger"

const log = createLogger("verify")

export interface IVerification {
  ok: boolean
  /** The factual rewrite when the draft overstated what happened. */
  reply?: string
  elapsedMs: number
  timedOut: boolean
  /** The verifier could not be used (no outcomes, disabled, unparseable answer). */
  skipped: boolean
}

export interface IVerificationDeps {
  auxComplete(systemPrompt: string, history: Event[], tools: never[]): Promise<ModelResponse>
}

export interface IVerificationConfig {
  enabled: boolean
  timeoutMs: number
}

const URL_RE = /https?:\/\/[^\s)]+/gi

/** The rewrite may only restate: no more than ~3× the draft (+500) and no URL the draft did not already carry. */
export function plausibleRewrite(draft: string, reply: string): boolean {
  if (reply.length > draft.length * 3 + 500) return false
  const known = new Set((draft.match(URL_RE) ?? []).map(u => u.toLowerCase()))
  return (reply.match(URL_RE) ?? []).every(u => known.has(u.toLowerCase()))
}

/**
 * Verified completion (CLEAN-150 US5): after a turn that ran a mutating
 * tool, the draft reply is checked against the tool outcomes by the
 * auxiliary model, within a time bound. A claim the outcomes do not support
 * is rewritten; on timeout the draft goes out marked unverified. Read-only
 * turns never get here.
 */
export class VerificationService {
  constructor(private deps: IVerificationDeps, private cfg: IVerificationConfig) {}

  async verify(draft: string, outcomes: IToolOutcome[]): Promise<IVerification> {
    const started = Date.now()
    const done = (v: Omit<IVerification, "elapsedMs">): IVerification => ({ ...v, elapsedMs: Date.now() - started })
    if (!this.cfg.enabled || outcomes.length === 0 || !draft.trim()) return done({ ok: true, timedOut: false, skipped: true })

    const history: Event[] = [{ id: "verify", type: "user", ts: Date.now(), data: { text: "Check the draft reply.", from: "verifier" } }]
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">(res => { timer = setTimeout(() => res("timeout"), this.cfg.timeoutMs) })
    try {
      const answer = await Promise.race([this.deps.auxComplete(buildVerificationPrompt(outcomes, draft), history, []), timeout])
      if (answer === "timeout") {
        log.warn(`verification timed out after ${this.cfg.timeoutMs}ms — reply goes out unverified`)
        return done({ ok: true, timedOut: true, skipped: false })
      }
      const parsed = parseVerification(answer.text)
      if (!parsed) {
        log.warn("verifier answered in an unexpected shape — reply goes out as drafted")
        return done({ ok: true, timedOut: false, skipped: true })
      }
      if (parsed.ok) return done({ ok: true, timedOut: false, skipped: false })
      // A rewrite that balloons or smuggles a link/tool call the draft never
      // had is not a correction; keep the draft and say it was not verified.
      if (!plausibleRewrite(draft, parsed.reply)) {
        log.warn("verifier's rewrite was out of bounds (size or new links) — reply goes out as drafted, unverified")
        return done({ ok: true, timedOut: true, skipped: false })
      }
      log.info(`verification rewrote a reply (${outcomes.filter(o => o.outcome !== "ok").length} failed outcome(s))`)
      return done({ ok: false, reply: parsed.reply, timedOut: false, skipped: false })
    } catch (err) {
      log.warn(`verification failed: ${(err as Error).message} — reply goes out as drafted`)
      return done({ ok: true, timedOut: false, skipped: true })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
