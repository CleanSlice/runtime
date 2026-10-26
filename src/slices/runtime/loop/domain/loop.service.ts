import type { Event } from "../../../setup/event"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { SessionModule } from "../../../agent/session/session.module"
import type { ActivityService } from "../../../bot/activity/domain/activity.service"
import type { UsageModule } from "../../../bot/usage/usage.module"
import type { VoiceModule } from "../../../bot/voice/voice.module"
import type { ChannelModule } from "../../../setup/channel/channel.module"
import type { Tool } from "../../../agent/tool"
import { effectOfCall } from "../../../agent/tool/domain/tool.types"
import type { GuardModule, IGuardCall, CallOutcome } from "../../../agent/guard"
import type { SkillModule } from "../../../agent/skill/skill.module"
import type { InstinctModule } from "../../../agent/instinct/instinct.module"
import type { VerificationService } from "./verification.service"
import type { DelegateService } from "./delegate.service"
import type { TaskManager } from "../../../agent/task/domain/task.service"
import { OUTCOME_PREVIEW_CHARS, type IToolOutcome } from "./prompts/verification.prompt"
import { skillEvent } from "../../../agent/skill/domain/skillEvent"
import type { ILoopContext, ILoopConfig, ILoopResult, IAssistantBubble, ISource } from "./loop.types"
import { LOOP_DEFAULTS } from "./loop.types"
import { SourceRegistry, citeBlock, extractSources, finalizeBubble, stripMarkers } from "./sources"
import { ERROR_HINT_PROMPT, CONTINUATION_PROMPT, buildAnchoredContinuationPrompt } from "../../../agent/agent/domain/prompts/error-hint.prompt"
import { isSilentReply } from "../../../agent/agent/domain/silentReply"
import { LastTurnStatsTracker } from "./last-turn-stats.tracker"
import { capPayload, fitEventsToBudget } from "../../../agent/session/domain/contextBudget"
import { randomUUID } from "crypto"
import { createLogger } from "../../../setup/logger"

const log = createLogger("loop")

interface LoopServiceDeps {
  llm: LlmModule
  session: SessionModule
  activity: ActivityService
  usage: UsageModule
  voice: VoiceModule
  channel: ChannelModule
  tools: Tool[]
  /** Guardrails around every tool call (CLEAN-150 US1). Absent in tests that exercise the bare loop. */
  guard?: GuardModule
  /** Skills — the body of a skill the model pulls in with `skill_load` goes into the history (CLEAN-150 US2). */
  skills?: SkillModule
  /** Learned behaviours — `agent_status` reports the counts (CLEAN-150 US3). */
  instincts?: InstinctModule
  /** Completion check after mutating tools (CLEAN-150 US5). */
  verification?: VerificationService
  /** Task manager — the completion contract looks up a turn's delegated workers (CLEAN-150 US6). */
  tasks?: TaskManager
}

// Channels that support live token-by-token streaming. The channel repository
// must implement `streamSend` (telegram edits the message; bridle emits stream
// events to the browser). Internal/cron/heartbeat traffic is excluded — there's
// no UI to update.
const STREAMING_CHANNELS = new Set(["telegram", "bridle"])

/** The head of a serialized tool result, for the verifier. */
function previewOf(result: unknown): string {
  let text: string
  try {
    text = typeof result === "string" ? result : (JSON.stringify(result) ?? "")
  } catch {
    text = String(result)
  }
  return text.length > OUTCOME_PREVIEW_CHARS ? text.slice(0, OUTCOME_PREVIEW_CHARS) + "…" : text
}

function canStreamOnChannel(channel: string, isInternal: boolean): boolean {
  return !isInternal && STREAMING_CHANNELS.has(channel)
}

/** `search_kb` → "Search kb" — visitor-facing thinking-step label from a tool name. */
function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

/**
 * Visitor-facing step label: the tool's own safe extract when it provides
 * one, else the humanized tool name. A label builder must never break the
 * loop — anything thrown or empty falls back silently.
 */
function buildStepLabel(tool: Tool | undefined, call: { name: string; params: unknown }): string {
  try {
    const custom = tool?.stepLabel?.(call.params)
    if (custom && custom.trim()) return custom.trim().slice(0, 80)
  } catch {
    // fall through to the generic name
  }
  return humanizeToolName(call.name)
}

/** One finished bubble's text after the citation check, and what it cites (CLEAN-138). */
type BubbleFinalizer = (text: string) => { text: string; sources: ISource[] }

/** What one bubble cites, as stored on the assistant event (`data.sources`). */
interface IBubbleSources {
  messageId: string
  sources: ISource[]
}

/**
 * The sources a tool call consulted, off its RAW result: the tool's own
 * reading when it has one, else the contract's `sources` key. A hook must
 * never break the loop — anything thrown counts as "none".
 */
function sourcesOf(tool: Tool | undefined, params: unknown, result: unknown): ISource[] {
  try {
    return tool?.sources?.(params, result) ?? extractSources(result)
  } catch (err) {
    log.warn(`sources hook failed for ${tool?.name ?? "unknown tool"}`, err)
    return []
  }
}

/**
 * Puts the "Sources you may cite" block where the model will read it.
 * Every provider hands `data.result` to the model as `JSON.stringify(result)`,
 * so text appended to a serialised string would arrive double-encoded; a
 * key on the object arrives as plain text. A result that is not an object
 * (an MCP content array, a web_search list) is wrapped so the key has a
 * place to sit.
 */
function withCitations(data: unknown, block: string): unknown {
  const d = data as { result?: unknown }
  const result = d.result
  const cited = result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), citations: block }
    : { result, citations: block }
  return { ...d, result: cited }
}

function isDebugEnabled(deps: LoopServiceDeps): boolean {
  // Order: explicit env override > NODE_ENV=development > runtime hub-pushed flag.
  // Env is checked first so a developer running locally can force debug on
  // without depending on the API/hub round-trip.
  if (process.env.BRIDLE_DEBUG === "true") return true
  if (process.env.NODE_ENV === "development") return true
  return deps.channel.isBridleDebugEnabled()
}

export class LoopService {
  private config: ILoopConfig
  public readonly lastTurnStats = new LastTurnStatsTracker()
  /** Per task: mutating tool outcomes of the turn (CLEAN-150 US5). */
  private mutating = new Map<string, IToolOutcome[]>()
  /** Per task: whether the latest LLM call streamed to the channel. */
  private streamed = new Map<string, boolean>()
  /** Delegation — set after construction because the service needs this loop to run workers. */
  private delegate?: DelegateService

  setDelegate(delegate: DelegateService): void {
    this.delegate = delegate
  }

  constructor(
    private deps: LoopServiceDeps,
    config?: Partial<ILoopConfig>,
  ) {
    this.config = { ...LOOP_DEFAULTS, ...config }
  }

  /** Update maxIterations after construction (e.g. after an agent.config.json reload). */
  updateMaxIterations(maxIterations: number): void {
    this.config.maxIterations = maxIterations
  }

  async run(ctx: ILoopContext): Promise<ILoopResult> {
    const { task, sessionId, history, tools } = ctx
    const tid = task.id.slice(0, 6)
    const rlog = log.child(tid)

    let continueLoop = true
    let iterations = 0
    let continuationCount = 0
    let consecutiveErrors = 0
    let errorLimitHit = false
    let accumulatedText = ""
    // Mutating tool outcomes of this turn — what the final reply is checked
    // against (CLEAN-150 US5). While any exist, the final call does not
    // stream: a rewritten reply has to be sent whole.
    this.mutating.set(task.id, [])
    this.streamed.delete(task.id)
    let childrenSettled = false
    // What the person actually saw: on a streaming channel every iteration
    // with text went out as its own bubble, under its own id. The turn is
    // still stored as ONE assistant event (the model-facing history must not
    // change shape), but it carries these boundaries — without them a replay
    // glues "Let me check:" and "Done!" into "Let me check:Done!" (CLEAN-102).
    const bubbles: IAssistantBubble[] = []
    // The sources this turn consulted, numbered as the model saw them in its
    // tool results (CLEAN-138). One registry per turn: a number means the
    // same source in every bubble, and numbers never collide across tool
    // calls. What each bubble actually cited goes on the assistant event.
    const registry = new SourceRegistry()
    const bubbleSources: IBubbleSources[] = []
    // A client that can draw sources gets the check — unknown markers out,
    // the rest renumbered. Everyone else gets the markers stripped: the
    // model had no numbers to cite, so a marker there points at nothing.
    const finalize: BubbleFinalizer = (text) => ctx.citeSources
      ? finalizeBubble(text, registry)
      : { text: stripMarkers(text), sources: [] }

    // Light the channel's thinking indicator immediately — the first LLM byte
    // can be seconds away (prompt build + model latency), and tool-only
    // iterations would otherwise leave the UI dead until the final response.
    ctx.sendTyping?.()

    // One thinking timeline per turn — every step event references it.
    const turnId = randomUUID()
    let thinkingStepsEmitted = false
    // On streaming channels the interleaved text of a tool-call iteration
    // already reaches the client as its own bubble; repeating it as step
    // detail would show it twice. Attach detail only when it doesn't stream.
    const streamsToClient = canStreamOnChannel(ctx.channel, ctx.isInternal) && this.deps.llm.canStream()

    while (continueLoop) {
      if (task.controller.signal.aborted) {
        rlog.info(`cancelled`)
        break
      }

      // Check inbox — if user sent clarification, append it to history and session
      await this.drainInbox(ctx)

      if (++iterations > this.config.maxIterations) {
        rlog.error(`exceeded ${this.config.maxIterations} iterations`)
        await ctx.send("⚠️ Reached max iterations. Please try again.")
        break
      }

      let response
      const llmStartMs = Date.now()
      try {
        let bubbleId: string | undefined
        let bubbleCited: ISource[] = []
        response = await this.callLlm(ctx, finalize, (id, cited) => { bubbleId = id; bubbleCited = cited })
        if (bubbleId && response.text) {
          bubbles.push({ id: bubbleId, text: response.text, ts: Date.now() })
          // `stream_end` is out by now, so the list follows as its own event.
          if (bubbleCited.length > 0) {
            bubbleSources.push({ messageId: bubbleId, sources: bubbleCited })
            ctx.sendSources?.(bubbleId, response.text, bubbleCited)
          }
        }
        if (response.usage) this.deps.usage.add(response.usage)
        const elapsedMs = Date.now() - llmStartMs
        this.maybeEmitDebug(ctx, response, elapsedMs)
        this.lastTurnStats.record(sessionId, {
          elapsedMs,
          retries: response.meta?.retries ?? 0,
          rateLimited: response.meta?.rateLimited ?? false,
          overloaded: response.meta?.overloaded ?? false,
          model: response.usage?.model ?? this.deps.llm.describe().model,
          occurredAt: Date.now(),
        })
      } catch (err: unknown) {
        const elapsedMs = Date.now() - llmStartMs
        const status = (err as { status?: number })?.status
        const errMsg = String((err as { message?: unknown })?.message ?? err ?? "")
        const isOverloaded = errMsg.includes("overloaded_error") || errMsg.includes("Overloaded") || status === 529
        const isRateLimited = status === 429 || errMsg.includes("rate_limit") || errMsg.includes("Rate limit")
        this.lastTurnStats.record(sessionId, {
          elapsedMs,
          retries: 0, // unknown — gateway swallowed inner retry count
          rateLimited: isRateLimited,
          overloaded: isOverloaded,
          model: this.deps.llm.describe().model,
          occurredAt: Date.now(),
        })
        rlog.error(`LLM error${status ? ` (${status})` : ""}`, errMsg.slice(0, 120))
        if (!ctx.isInternal) {
          await ctx.send(isOverloaded
            ? "⚠️ AI server is overloaded. Wait a minute and try again."
            : "⚠️ Something went wrong. Please try again.")
        }
        break
      }

      // Accumulate any text from responses that also contain tool calls
      if (response.text && response.toolCalls && response.toolCalls.length > 0) {
        accumulatedText += response.text
      }

      if (response.toolCalls && response.toolCalls.length > 0 && !errorLimitHit) {
        // Keep the indicator alive while tools run — streamSend's own typing
        // only covers the LLM call, not the tool execution that follows.
        ctx.sendTyping?.()
        if (ctx.sendThinking) thinkingStepsEmitted = true
        // The reasoning prose rides the thinking timeline to the person, so
        // it gets the same redaction as a reply.
        const detail = response.text || undefined
        const iterationHadError = await this.executeToolCalls(
          ctx,
          response,
          iterations,
          turnId,
          registry,
          streamsToClient ? undefined : (detail && this.deps.guard ? this.deps.guard.redactOutgoing(detail) : detail),
        )

        if (iterationHadError) {
          consecutiveErrors++
          rlog.warn(`consecutive error iterations: ${consecutiveErrors}/${this.config.maxConsecutiveErrors}`)
        } else {
          consecutiveErrors = 0
        }

        if (consecutiveErrors >= this.config.maxConsecutiveErrors && !errorLimitHit) {
          rlog.error(`${this.config.maxConsecutiveErrors} consecutive iterations with tool errors — requesting final summary`)
          errorLimitHit = true
          const hintEvent: Event = {
            id: randomUUID(),
            type: "user",
            ts: Date.now(),
            data: { text: ERROR_HINT_PROMPT, from: ctx.from },
          }
          history.push(hintEvent)
        }

        // If max_tokens hit during a tool call response, inject continuation
        if (response.stopReason === "max_tokens") {
          rlog.info(`max_tokens hit during tool response, requesting continuation…`)
          const continueEvent: Event = {
            id: randomUUID(),
            type: "user",
            ts: Date.now(),
            data: { text: CONTINUATION_PROMPT, from: ctx.from, transient: true },
          }
          await this.deps.session.append(sessionId, continueEvent)
          history.push(continueEvent)
        }
      } else {
        // No tool calls — text-only response
        if (response.stopReason === "max_tokens" && response.text && continuationCount < this.config.maxContinuations) {
          continuationCount++
          rlog.info(`max_tokens hit (${response.text.length} chars), continuation ${continuationCount}/${this.config.maxContinuations}…`)
          accumulatedText += response.text

          const partialEvent: Event = {
            id: randomUUID(),
            type: "assistant",
            ts: Date.now(),
            data: { text: response.text, transient: true },
          }
          await this.deps.session.append(sessionId, partialEvent)
          history.push(partialEvent)

          const lastSnippet = response.text.trimEnd().slice(-150)
          const continueEvent: Event = {
            id: randomUUID(),
            type: "user",
            ts: Date.now(),
            data: { text: buildAnchoredContinuationPrompt(lastSnippet), from: ctx.from, transient: true },
          }
          await this.deps.session.append(sessionId, continueEvent)
          history.push(continueEvent)
        } else {
          // Completion contract (CLEAN-150 US6): a turn does not end while
          // its delegated workers run. Wait for them within the budget, then
          // cancel what is left and give the model the facts for one more
          // iteration — once per turn.
          const note = !childrenSettled && !ctx.worker ? await this.settleChildren(ctx) : undefined
          if (note) {
            childrenSettled = true
            const noteEvent: Event = { id: randomUUID(), type: "user", ts: Date.now(), data: { text: note, from: ctx.from, transient: true } }
            await this.deps.session.append(sessionId, noteEvent)
            history.push(noteEvent)
            continue
          }
          if (response.text) accumulatedText += response.text
          continueLoop = false
        }

        // Send only when the loop is done (all continuations complete)
        if (!continueLoop && accumulatedText) {
          accumulatedText = await this.verifyCompletion(ctx, accumulatedText)
          await this.sendFinalResponse(ctx, accumulatedText, iterations, bubbles, bubbleSources, finalize)
        }
      }
    }

    // Close the thinking timeline so capable clients collapse the block.
    // Runs on every exit path — completion, cancellation, LLM error breaks.
    if (thinkingStepsEmitted) ctx.sendThinking?.(turnId)

    // If error limit was hit but no final response was generated, send fallback
    if (errorLimitHit && accumulatedText === "") {
      await ctx.send("⚠️ Multiple attempts failed. The requested resource may be unavailable.")
    }

    this.mutating.delete(task.id)
    this.streamed.delete(task.id)
    return { text: accumulatedText, errorLimitHit }
  }

  /**
   * Completion contract (CLEAN-150 US6). Returns a system note when workers
   * of this turn were still running: they are given the delegate budget to
   * finish, the rest are cancelled, and the note lists what happened so the
   * model reports it instead of ending with "waiting". Undefined when there
   * was nothing to wait for.
   */
  private async settleChildren(ctx: ILoopContext): Promise<string | undefined> {
    const tasks = this.deps.tasks
    if (!tasks) return undefined
    const running = () => tasks.getChildren(ctx.task.id).filter(t => t.status === "running")
    if (running().length === 0) return undefined

    const rlog = log.child(ctx.task.id.slice(0, 6))
    const budgetMs = ctx.agentConfig.tools?.delegate?.timeoutMs ?? 300_000
    rlog.warn(`${running().length} delegated worker(s) still running at turn end — waiting up to ${Math.round(budgetMs / 1000)}s`)
    const deadline = Date.now() + budgetMs
    while (running().length > 0 && Date.now() < deadline) {
      if (ctx.task.controller.signal.aborted) break
      await new Promise(r => setTimeout(r, 100))
    }
    const children = tasks.getChildren(ctx.task.id)
    const cancelled = running()
    for (const c of cancelled) tasks.cancel(c.id)
    const finished = children.filter(c => !cancelled.includes(c))
    const line = (t: { label: string; status: string }) => `${t.label} (${t.status})`
    return (
      `[System: your delegated workers were still running when you tried to finish. ` +
      `Finished since: ${finished.map(line).join("; ") || "none"}. ` +
      `Cancelled at the budget: ${cancelled.map(c => c.label).join("; ") || "none"}. ` +
      `Report exactly this to the person — what completed, what did not — without claiming results you do not have.]`
    )
  }

  /**
   * Verified completion (CLEAN-150 US5): after mutating tools, the draft is
   * checked against their outcomes. An unsupported claim is replaced by the
   * verifier's factual rewrite; a timeout lets the draft through, marked.
   */
  private async verifyCompletion(ctx: ILoopContext, draft: string): Promise<string> {
    const outcomes = this.mutating.get(ctx.task.id) ?? []
    if (!this.deps.verification || outcomes.length === 0 || isSilentReply(draft)) return draft
    const rlog = log.child(ctx.task.id.slice(0, 6))
    const v = await this.deps.verification.verify(draft, outcomes)
    if (v.timedOut) {
      rlog.warn(`verification: timeout (${v.elapsedMs}ms) — delivering unverified`)
      return `${draft} (unverified)`
    }
    if (v.skipped) {
      rlog.info(`verification: skipped`)
      return draft
    }
    if (!v.ok && v.reply) {
      rlog.info(`verification: rewritten (${v.elapsedMs}ms)`)
      return v.reply
    }
    rlog.info(`verification: ok (${v.elapsedMs}ms)`)
    return draft
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private async drainInbox(ctx: ILoopContext): Promise<void> {
    const { task, sessionId, history } = ctx
    const tid = task.id.slice(0, 6)
    const rlog = log.child(tid)
    while (task.inbox.length > 0) {
      const inboxText = task.inbox.shift()!
      rlog.info(`← inbox: "${inboxText.slice(0, 40)}"`)
      const inboxEvent: Event = {
        id: randomUUID(),
        type: "user",
        ts: Date.now(),
        data: { text: inboxText, from: ctx.from },
        taskId: task.id,
      }
      await this.deps.session.append(sessionId, inboxEvent)
      history.push(inboxEvent)
    }
  }

  /** `onBubble` fires with the wire message id when the channel showed this
   *  call's text as a bubble of its own (streaming channels that mint ids),
   *  and with the sources that bubble cites after `finalize` ran over it. */
  private async callLlm(
    ctx: ILoopContext,
    finalize: BubbleFinalizer,
    onBubble?: (messageId: string, cited: ISource[]) => void,
  ) {
    const { channel, isInternal, systemPrompt, tools } = ctx
    // Tool results pile up inside one turn too; the model always gets a
    // history that fits its window (CLEAN-124).
    const history = fitEventsToBudget(ctx.history, this.config.contextBudgetChars).events
    const channelOk = canStreamOnChannel(channel, isInternal)
    const llmOk = this.deps.llm.canStream()
    // A turn that already changed something gets a complete, verifiable
    // final reply rather than a stream (CLEAN-150 US5).
    const verifiable = !!this.deps.verification && (this.mutating.get(ctx.task.id)?.length ?? 0) > 0
    const canStream = channelOk && llmOk && !verifiable
    const tid = ctx.task.id.slice(0, 6)
    log.child(tid).info(
      `llm call: channel=${channel} internal=${isInternal} ` +
      `streamingChannel=${channelOk} llmStreams=${llmOk} → ${canStream ? "stream" : "complete"}`,
    )
    if (canStream) {
      let streamedResponse: import("../../../setup/llm/domain/llm.types").ModelResponse | undefined
      let cited: ISource[] = []
      // Chunks carry the accumulated text; a streamed reply must not show a
      // credential the final redaction would have masked (CLEAN-150 FR-005).
      const guard = this.deps.guard
      const messageId = await ctx.streamSend(channel, ctx.from, async (onChunk) => {
        const safeChunk = guard ? (text: string) => onChunk(guard.redactStreaming(text)) : onChunk
        streamedResponse = await this.deps.llm.stream(systemPrompt, history, tools, safeChunk)
        const finalText = streamedResponse.text ?? ""
        const safeText = guard ? guard.redactOutgoing(finalText) : finalText
        // The bubble is complete here and the channel has not sent its final
        // text yet — what the streamer returns is what `stream_end` (bridle)
        // or the last edit (telegram) carries. Check the citations now, so
        // the text the person keeps is the corrected one (CLEAN-138).
        const fixed = finalize(safeText)
        streamedResponse = { ...streamedResponse, text: fixed.text }
        cited = fixed.sources
        return fixed.text
      })
      if (messageId) onBubble?.(messageId, cited)
      if (streamedResponse) {
        this.streamed.set(ctx.task.id, true)
        return streamedResponse
      }
    }
    this.streamed.set(ctx.task.id, false)
    // Not streamed: the text is one bubble sent once at the end of the turn,
    // and may be several iterations glued together — sendFinalResponse runs
    // the check over the whole of it.
    return this.deps.llm.complete(systemPrompt, history, tools)
  }

  private async executeToolCalls(
    ctx: ILoopContext,
    response: import("../../../setup/llm/domain/llm.types").ModelResponse,
    iterations: number,
    turnId: string,
    registry: SourceRegistry,
    iterationDetail?: string,
  ): Promise<boolean> {
    const { task, sessionId, history } = ctx
    const tid = task.id.slice(0, 6)
    const rlog = log.child(tid)
    let iterationHadError = false
    // The iteration's interleaved reasoning text rides on its first step only.
    let firstStepOfIteration = true

    for (const call of response.toolCalls!) {
      if (task.controller.signal.aborted) break
      const iterTag = iterations > 1 ? ` #${iterations}` : ""
      rlog.info(`${iterTag} llm → ${call.name}`)
      this.deps.activity.updateStep(`tool_call: ${call.name}`)

      const tool = this.deps.tools.find(t => t.name === call.name)
      if (!tool) rlog.warn(`unknown tool: ${call.name}`)

      // Visitor-facing step: the tool's safe label extract (or its humanized
      // name) + optional reasoning prose. Raw params stay off the wire —
      // this event is not admin-gated.
      const thinkingStep = {
        id: randomUUID(),
        label: buildStepLabel(tool, call),
        ...(firstStepOfIteration && iterationDetail ? { detail: iterationDetail } : {}),
      }
      firstStepOfIteration = false
      ctx.sendThinking?.(turnId, { ...thinkingStep, state: "active" })

      const toolUseId = randomUUID()
      // Persisted params are credential-masked: the transcript syncs to S3,
      // and a token the model typed out would otherwise live there forever.
      const callEvent: Event = {
        id: randomUUID(),
        type: "tool_call",
        ts: Date.now(),
        data: { name: call.name, params: this.deps.guard ? this.deps.guard.redactValue(call.params) : call.params, toolUseId },
      }
      await this.deps.session.append(sessionId, callEvent)
      history.push(callEvent)

      let result: unknown
      // Guardrails: the rules see every call with the same params the tool
      // would get; a block never reaches the tool, a redact rewrites params.
      const guardCall: IGuardCall = {
        tool: call.name,
        params: call.params,
        agentDir: ctx.agentDir,
        sessionId,
        turnId,
        effect: tool ? effectOfCall(tool, call.params) : "write",
      }
      const startedMs = Date.now()
      let outcome: CallOutcome = "ok"
      let rulesFired: string[] = []
      let params = call.params

      const adminBlocked = tool && tool.adminOnly && !ctx.isAdmin
      // Workers observe unless tools.delegate.allowWrite is on — enforced per
      // call so `file` write / `http` POST are caught even though the tool
      // itself is allowed (CLEAN-150 US6).
      const workerBlocked = tool && ctx.worker && guardCall.effect === "write" && ctx.agentConfig.tools?.delegate?.allowWrite !== true
      const verdict = tool && !adminBlocked && !workerBlocked && this.deps.guard ? this.deps.guard.before(guardCall) : undefined
      if (verdict?.kind === "allow") {
        params = verdict.params
        rulesFired = verdict.rulesFired
      }

      if (adminBlocked) {
        rlog.warn(`admin-only tool blocked for non-admin: ${call.name} (from=${ctx.from})`)
        result = { error: `Tool "${call.name}" is admin-only and cannot be called by this user.` }
        outcome = "blocked"
      } else if (workerBlocked) {
        rlog.warn(`write call refused inside a worker: ${call.name}`)
        result = { error: `Workers are read-only: "${call.name}" would change something. Report what you found; the parent decides what to do.` }
        outcome = "blocked"
      } else if (verdict?.kind === "block") {
        rlog.warn(`blocked by rule ${verdict.ruleId}: ${call.name}`)
        result = { error: `blocked by rule ${verdict.ruleId}: ${verdict.reason}` }
        outcome = "blocked"
        rulesFired = [verdict.ruleId]
      } else if (tool) {
        try {
          result = await Promise.race([
            tool.execute(params, {
              sessionId,
              agentDir: ctx.agentDir,
              from: ctx.from,
              ...(ctx.user ? { user: ctx.user } : {}),
              ...(ctx.origin ? { origin: ctx.origin } : {}),
              channel: ctx.channel,
              send: async (text, parts) => { await ctx.send(text, parts) },
              agentConfig: ctx.agentConfig,
              reloadSkills: ctx.reloadSkills,
              access: ctx.access,
              isAdmin: ctx.isAdmin,
              channels: ctx.channels,
              llm: this.deps.llm,
              usage: this.deps.usage,
              lastTurnStats: this.lastTurnStats,
              tools: ctx.tools,
              guard: this.deps.guard,
              skills: this.deps.skills,
              instincts: this.deps.instincts,
              turn: ctx.turn,
              promptBreakdown: ctx.breakdown,
              lastCompaction: this.deps.session.lastCompaction?.(sessionId),
              // Workers cannot delegate further (CLEAN-150 US6).
              delegate: this.delegate && !ctx.worker ? (requests) => this.delegate!.run(ctx, requests) : undefined,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Tool "${call.name}" timed out after ${this.config.toolTimeout / 1000}s`)), this.config.toolTimeout)
            ),
          ])
        } catch (err) {
          result = { error: String(err) }
          outcome = String(err).includes("timed out") ? "timeout" : "error"
        }
      } else {
        result = { error: `Unknown tool: ${call.name}` }
        outcome = "error"
      }

      const errorValue = result && typeof result === "object" ? (result as Record<string, unknown>).error : undefined
      if (errorValue) {
        iterationHadError = true
        if (outcome === "ok") outcome = "error"
        rlog.warn(`tool error: ${String(errorValue).slice(0, 80)}`)
      }

      // Which sources this call consulted, read off the RAW result: the cap
      // below may drop the tail of a long list, and a source the model read
      // about in the part that survived must still be citable (CLEAN-138).
      // The registry hands out the numbers; a source seen earlier in the
      // turn keeps the one it had.
      const consulted = sourcesOf(tool, call.params, result)
      const citable: Array<{ n: number; source: ISource }> = []
      for (let i = 0; i < consulted.length; i++) {
        const n = registry.numberOf(consulted[i])
        if (!citable.some((c) => c.n === n)) citable.push({ n, source: consulted[i] })
      }

      // After-rules: redaction and records. Credentials are masked in the
      // copy the model sees AND in the persisted one (the transcript is a log
      // that leaves the box); only the size cap keeps the CLEAN-124 split of
      // full-on-disk / trimmed-in-context.
      let modelResult = result
      let redacted = false
      if (this.deps.guard) {
        const after = await this.deps.guard.after(guardCall, result, { outcome, durationMs: Date.now() - startedMs, rulesFired })
        modelResult = after.result
        redacted = after.redacted
      }

      const resultEvent: Event = {
        id: randomUUID(),
        type: "tool_result",
        ts: Date.now(),
        data: {
          toolUseId,
          result: modelResult,
          ...(outcome === "blocked" ? { blocked: true } : {}),
          ...(redacted ? { redacted: true } : {}),
        },
      }
      await this.deps.session.append(sessionId, resultEvent)
      // The transcript keeps the full result; the model gets one that fits
      // (CLEAN-124). Same cap the next turn's history rebuild applies.
      const capped = capPayload(resultEvent.data, this.config.maxToolOutputChars)
      // Only the model's copy learns which numbers it may cite, and only
      // when the client can show them — the stored event is the tool's
      // result as returned.
      const forModel = ctx.citeSources && citable.length > 0
        ? withCitations(capped, citeBlock(citable))
        : capped
      history.push(forModel === resultEvent.data ? resultEvent : { ...resultEvent, data: forModel })

      // Mutating outcomes feed the completion check (CLEAN-150 US5).
      if (guardCall.effect === "write") {
        this.mutating.get(task.id)?.push({
          tool: call.name,
          outcome,
          result: previewOf(modelResult),
        })
      }

      // On-demand context (CLEAN-150 US2): a loaded skill's body enters the
      // history ahead of the conversation — not the system prompt, whose
      // cached prefix must stay stable — and both kinds of load are reported
      // so the turn's breakdown shows what came in late.
      if (outcome === "ok") this.noteOnDemandLoad(ctx, call.name, result)

      ctx.sendThinking?.(turnId, { ...thinkingStep, state: "done" })
    }

    return iterationHadError
  }

  private noteOnDemandLoad(ctx: ILoopContext, toolName: string, result: unknown): void {
    if (toolName === "skill_load") {
      const name = (result as { name?: string })?.name
      const skill = name ? this.deps.skills?.get(name) : undefined
      if (!skill) return
      const event = skillEvent(skill)
      const insertAt = ctx.history[0]?.type === "summary" && !(ctx.history[0].data as { skill?: string }).skill ? 1 : 0
      // Replace an earlier copy of the same skill rather than stacking two.
      const existing = ctx.history.findIndex(e => e.type === "summary" && (e.data as { skill?: string }).skill === skill.name)
      if (existing >= 0) ctx.history.splice(existing, 1)
      ctx.history.splice(insertAt, 0, event)
      ctx.onDemandLoad?.({ kind: "skill", name: skill.name, chars: skill.content.length })
    } else if (toolName === "tool_describe") {
      const name = (result as { name?: string })?.name
      if (name) ctx.onDemandLoad?.({ kind: "tool", name, chars: JSON.stringify(result).length })
    }
  }

  private maybeEmitDebug(
    ctx: ILoopContext,
    response: import("../../../setup/llm/domain/llm.types").ModelResponse,
    latencyMs: number,
  ): void {
    if (!ctx.sendDebug) return
    if (ctx.channel !== "bridle") return
    if (!isDebugEnabled(this.deps)) return

    try {
      const { provider, model } = this.deps.llm.describe()
      ctx.sendDebug({
        model,
        provider,
        systemPrompt: ctx.systemPrompt,
        history: ctx.history,
        response: {
          text: this.deps.guard ? this.deps.guard.redactOutgoing(response.text ?? "") : (response.text ?? ""),
          toolCalls: response.toolCalls,
          stopReason: response.stopReason,
        },
        usage: response.usage,
        latencyMs,
      })
    } catch (err) {
      // Debug must never break the chat path.
      log.warn("failed to emit debug snapshot", err)
    }
  }

  private async sendFinalResponse(
    ctx: ILoopContext,
    fullText: string,
    iterations: number,
    bubbles: IAssistantBubble[] = [],
    bubbleSources: IBubbleSources[] = [],
    finalize: BubbleFinalizer = (text) => ({ text, sources: [] }),
  ): Promise<void> {
    const tid = ctx.task.id.slice(0, 6)
    const rlog = log.child(tid)
    const iterTag = iterations > 1 ? ` #${iterations}` : ""

    // Silent reply: the model chose to stay quiet (e.g. recovery resumed a
    // completed task). Drop the message entirely — don't persist it as an
    // assistant event (would poison next-turn context) and don't ship to
    // the channel. For streaming channels the placeholder/stream_end is
    // already suppressed inside the repository.
    if (isSilentReply(fullText)) {
      rlog.info(`${iterTag} llm → NO_REPLY (suppressed)`)
      return
    }

    // A credential the model repeats from a tool result must not reach the
    // person either (CLEAN-150 FR-005).
    if (this.deps.guard) fullText = this.deps.guard.redactOutgoing(fullText)

    // If we streamed — message already sent via streamSend, skip re-send.
    // The last call records whether it actually streamed (a verifiable turn
    // deliberately does not); fall back to the channel check when unknown.
    const wasStreamed = this.streamed.get(ctx.task.id) ?? (canStreamOnChannel(ctx.channel, ctx.isInternal) && this.deps.llm.canStream())

    // Streamed bubbles had their citations checked one by one as they went
    // out (callLlm). A non-streamed turn is one bubble sent once, even when
    // max_tokens continuations glued several model outputs into it — so it
    // is checked here, once, over the whole text; checking each piece would
    // have restarted the numbering at 1 in the middle of the bubble.
    const fixed = wasStreamed ? { text: fullText, sources: [] as ISource[] } : finalize(fullText)
    const text = fixed.text

    const preview = text.slice(0, 50).replace(/\n/g, " ")
    rlog.info(`${iterTag} llm → "${preview}…" (${text.length})`)

    // A cited bubble is stored under its wire id, and a non-streamed send is
    // the only way to learn that id — so a cited non-streamed bubble goes
    // out before the event is written. Everything else keeps the old order:
    // store first, so the turn survives a channel that fails to deliver.
    const sources = [...bubbleSources]
    let sentEarly = false
    if (!wasStreamed && fixed.sources.length > 0) {
      const messageId = await ctx.send(text)
      sentEarly = true
      if (messageId) {
        sources.push({ messageId, sources: fixed.sources })
        ctx.sendSources?.(messageId, text, fixed.sources)
      }
    }

    const assistantEvent: Event = {
      id: randomUUID(),
      type: "assistant",
      ts: Date.now(),
      // `text` stays the whole turn — it is what every LLM prompt builder and
      // the compactor read. `messages` is display-only: the bubbles as sent.
      // `sources` is display-only too: what each bubble cites (CLEAN-138).
      data: {
        text,
        ...(bubbles.length ? { messages: bubbles } : {}),
        ...(sources.length ? { sources } : {}),
      },
    }
    await this.deps.session.append(ctx.sessionId, assistantEvent)

    if (!wasStreamed && !sentEarly) {
      if (ctx.channel === "telegram" && this.deps.voice.isEnabled(ctx.from)) {
        const tts = this.deps.tools.find(t => t.name === "tts")
        if (tts) {
          try {
            await tts.execute(
              { text, chat_id: ctx.from },
              {
                sessionId: ctx.sessionId,
                agentDir: ctx.agentDir,
                from: ctx.from,
                channel: ctx.channel,
                send: async (t, parts) => { await ctx.send(t, parts) },
              },
            )
          } catch (err) {
            rlog.error(`TTS failed`, err)
            await ctx.send(text)
          }
        } else {
          await ctx.send(text)
        }
      } else {
        await ctx.send(text)
      }
    }
  }
}
