import type { Event } from "../../../setup/event"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { SessionModule } from "../../../agent/session/session.module"
import type { ActivityService } from "../../../bot/activity/domain/activity.service"
import type { UsageModule } from "../../../bot/usage/usage.module"
import type { VoiceModule } from "../../../bot/voice/voice.module"
import type { ChannelModule } from "../../../setup/channel/channel.module"
import type { Tool } from "../../../agent/tool"
import type { ILoopContext, ILoopConfig, ILoopResult } from "./loop.types"
import { LOOP_DEFAULTS } from "./loop.types"
import { ERROR_HINT_PROMPT, CONTINUATION_PROMPT, buildAnchoredContinuationPrompt } from "../../../agent/agent/domain/prompts/error-hint.prompt"
import { isSilentReply } from "../../../agent/agent/domain/silentReply"
import { randomUUID } from "crypto"

interface LoopServiceDeps {
  llm: LlmModule
  session: SessionModule
  activity: ActivityService
  usage: UsageModule
  voice: VoiceModule
  channel: ChannelModule
  tools: Tool[]
}

// Channels that support live token-by-token streaming. The channel repository
// must implement `streamSend` (telegram edits the message; bridle emits stream
// events to the browser). Internal/cron/heartbeat traffic is excluded — there's
// no UI to update.
const STREAMING_CHANNELS = new Set(["telegram", "bridle"])

function canStreamOnChannel(channel: string, isInternal: boolean): boolean {
  return !isInternal && STREAMING_CHANNELS.has(channel)
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

  constructor(
    private deps: LoopServiceDeps,
    config?: Partial<ILoopConfig>,
  ) {
    this.config = { ...LOOP_DEFAULTS, ...config }
  }

  async run(ctx: ILoopContext): Promise<ILoopResult> {
    const { task, sessionId, history, tools } = ctx
    const tid = task.id.slice(0, 6)

    let continueLoop = true
    let iterations = 0
    let continuationCount = 0
    let consecutiveErrors = 0
    let errorLimitHit = false
    let accumulatedText = ""

    while (continueLoop) {
      if (task.controller.signal.aborted) {
        console.log(`[${tid}] cancelled`)
        break
      }

      // Check inbox — if user sent clarification, append it to history and session
      await this.drainInbox(ctx)

      if (++iterations > this.config.maxIterations) {
        console.error(`[${tid}] ✗ exceeded ${this.config.maxIterations} iterations`)
        await ctx.send("⚠️ Reached max iterations. Please try again.")
        break
      }

      let response
      const llmStartMs = Date.now()
      try {
        response = await this.callLlm(ctx)
        if (response.usage) this.deps.usage.add(response.usage)
        this.maybeEmitDebug(ctx, response, Date.now() - llmStartMs)
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status
        const errMsg = String((err as { message?: unknown })?.message ?? err ?? "")
        const isOverloaded = errMsg.includes("overloaded_error") || errMsg.includes("Overloaded") || status === 529
        console.error(`[${tid}] ✗ LLM error${status ? ` (${status})` : ""}:`, errMsg.slice(0, 120))
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
        const iterationHadError = await this.executeToolCalls(ctx, response, iterations)

        if (iterationHadError) {
          consecutiveErrors++
          console.warn(`[${tid}] consecutive error iterations: ${consecutiveErrors}/${this.config.maxConsecutiveErrors}`)
        } else {
          consecutiveErrors = 0
        }

        if (consecutiveErrors >= this.config.maxConsecutiveErrors && !errorLimitHit) {
          console.error(`[${tid}] ✗ ${this.config.maxConsecutiveErrors} consecutive iterations with tool errors — requesting final summary`)
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
          console.log(`[${tid}] max_tokens hit during tool response, requesting continuation…`)
          const continueEvent: Event = {
            id: randomUUID(),
            type: "user",
            ts: Date.now(),
            data: { text: CONTINUATION_PROMPT, from: ctx.from },
          }
          await this.deps.session.append(sessionId, continueEvent)
          history.push(continueEvent)
        }
      } else {
        // No tool calls — text-only response
        if (response.stopReason === "max_tokens" && response.text && continuationCount < this.config.maxContinuations) {
          continuationCount++
          console.log(`[${tid}] max_tokens hit (${response.text.length} chars), continuation ${continuationCount}/${this.config.maxContinuations}…`)
          accumulatedText += response.text

          const partialEvent: Event = {
            id: randomUUID(),
            type: "assistant",
            ts: Date.now(),
            data: { text: response.text },
          }
          await this.deps.session.append(sessionId, partialEvent)
          history.push(partialEvent)

          const lastSnippet = response.text.trimEnd().slice(-150)
          const continueEvent: Event = {
            id: randomUUID(),
            type: "user",
            ts: Date.now(),
            data: { text: buildAnchoredContinuationPrompt(lastSnippet), from: ctx.from },
          }
          await this.deps.session.append(sessionId, continueEvent)
          history.push(continueEvent)
        } else {
          if (response.text) accumulatedText += response.text
          continueLoop = false
        }

        // Send only when the loop is done (all continuations complete)
        if (!continueLoop && accumulatedText) {
          await this.sendFinalResponse(ctx, accumulatedText, iterations)
        }
      }
    }

    // If error limit was hit but no final response was generated, send fallback
    if (errorLimitHit && accumulatedText === "") {
      await ctx.send("⚠️ Multiple attempts failed. The requested resource may be unavailable.")
    }

    return { text: accumulatedText, errorLimitHit }
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private async drainInbox(ctx: ILoopContext): Promise<void> {
    const { task, sessionId, history } = ctx
    const tid = task.id.slice(0, 6)
    while (task.inbox.length > 0) {
      const inboxText = task.inbox.shift()!
      console.log(`[${tid}] ← inbox: "${inboxText.slice(0, 40)}"`)
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

  private async callLlm(ctx: ILoopContext) {
    const { channel, isInternal, systemPrompt, history, tools } = ctx
    const channelOk = canStreamOnChannel(channel, isInternal)
    const llmOk = this.deps.llm.canStream()
    const canStream = channelOk && llmOk
    const tid = ctx.task.id.slice(0, 6)
    console.log(
      `[${tid}] llm call: channel=${channel} internal=${isInternal} ` +
      `streamingChannel=${channelOk} llmStreams=${llmOk} → ${canStream ? "stream" : "complete"}`,
    )
    if (canStream) {
      let streamedResponse: import("../../../setup/llm/domain/llm.types").ModelResponse | undefined
      await ctx.streamSend(channel, ctx.from, async (onChunk) => {
        streamedResponse = await this.deps.llm.stream(systemPrompt, history, tools, onChunk)
        return streamedResponse.text ?? ""
      })
      if (streamedResponse) return streamedResponse
    }
    return this.deps.llm.complete(systemPrompt, history, tools)
  }

  private async executeToolCalls(
    ctx: ILoopContext,
    response: import("../../../setup/llm/domain/llm.types").ModelResponse,
    iterations: number,
  ): Promise<boolean> {
    const { task, sessionId, history } = ctx
    const tid = task.id.slice(0, 6)
    let iterationHadError = false

    for (const call of response.toolCalls!) {
      if (task.controller.signal.aborted) break
      const iterTag = iterations > 1 ? ` #${iterations}` : ""
      console.log(`[${tid}]${iterTag} llm → ${call.name}`)
      this.deps.activity.updateStep(`tool_call: ${call.name}`)

      const toolUseId = randomUUID()
      const callEvent: Event = {
        id: randomUUID(),
        type: "tool_call",
        ts: Date.now(),
        data: { name: call.name, params: call.params, toolUseId },
      }
      await this.deps.session.append(sessionId, callEvent)
      history.push(callEvent)

      const tool = this.deps.tools.find(t => t.name === call.name)
      if (!tool) console.warn(`[${tid}] ⚠ unknown tool: ${call.name}`)
      let result: unknown

      if (tool && tool.adminOnly && !ctx.isAdmin) {
        console.warn(`[${tid}] ⚠ admin-only tool blocked for non-admin: ${call.name} (from=${ctx.from})`)
        result = { error: `Tool "${call.name}" is admin-only and cannot be called by this user.` }
      } else if (tool) {
        try {
          result = await Promise.race([
            tool.execute(call.params, {
              sessionId,
              agentDir: ctx.agentDir,
              from: ctx.from,
              channel: ctx.channel,
              send: ctx.send,
              agentConfig: ctx.agentConfig,
              reloadSkills: ctx.reloadSkills,
              access: ctx.access,
              isAdmin: ctx.isAdmin,
              channels: ctx.channels,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Tool "${call.name}" timed out after ${this.config.toolTimeout / 1000}s`)), this.config.toolTimeout)
            ),
          ])
        } catch (err) {
          result = { error: String(err) }
        }
      } else {
        result = { error: `Unknown tool: ${call.name}` }
      }

      const errorValue = result && typeof result === "object" ? (result as Record<string, unknown>).error : undefined
      if (errorValue) {
        iterationHadError = true
        console.warn(`[${tid}] tool error: ${String(errorValue).slice(0, 80)}`)
      }

      const resultEvent: Event = {
        id: randomUUID(),
        type: "tool_result",
        ts: Date.now(),
        data: { toolUseId, result },
      }
      await this.deps.session.append(sessionId, resultEvent)
      history.push(resultEvent)
    }

    return iterationHadError
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
          text: response.text ?? "",
          toolCalls: response.toolCalls,
          stopReason: response.stopReason,
        },
        usage: response.usage,
        latencyMs,
      })
    } catch (err) {
      // Debug must never break the chat path.
      console.warn("[loop] failed to emit debug snapshot:", err)
    }
  }

  private async sendFinalResponse(ctx: ILoopContext, fullText: string, iterations: number): Promise<void> {
    const tid = ctx.task.id.slice(0, 6)
    const iterTag = iterations > 1 ? ` #${iterations}` : ""

    // Silent reply: the model chose to stay quiet (e.g. recovery resumed a
    // completed task). Drop the message entirely — don't persist it as an
    // assistant event (would poison next-turn context) and don't ship to
    // the channel. For streaming channels the placeholder/stream_end is
    // already suppressed inside the repository.
    if (isSilentReply(fullText)) {
      console.log(`[${tid}]${iterTag} llm → NO_REPLY (suppressed)`)
      return
    }

    const preview = fullText.slice(0, 50).replace(/\n/g, " ")
    console.log(`[${tid}]${iterTag} llm → "${preview}…" (${fullText.length})`)

    const assistantEvent: Event = {
      id: randomUUID(),
      type: "assistant",
      ts: Date.now(),
      data: { text: fullText },
    }
    await this.deps.session.append(ctx.sessionId, assistantEvent)

    // If we streamed — message already sent via streamSend, skip re-send
    const wasStreamed = canStreamOnChannel(ctx.channel, ctx.isInternal) && this.deps.llm.canStream()

    if (!wasStreamed) {
      if (ctx.channel === "telegram" && this.deps.voice.isEnabled(ctx.from)) {
        const tts = this.deps.tools.find(t => t.name === "tts")
        if (tts) {
          try {
            await tts.execute(
              { text: fullText, chat_id: ctx.from },
              { sessionId: ctx.sessionId, agentDir: ctx.agentDir, from: ctx.from, channel: ctx.channel, send: ctx.send },
            )
          } catch (err) {
            console.error(`[${tid}] ✗ TTS failed:`, err)
            await ctx.send(fullText)
          }
        } else {
          await ctx.send(fullText)
        }
      } else {
        await ctx.send(fullText)
      }
    }
  }
}
