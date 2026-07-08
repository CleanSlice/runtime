import { randomUUID } from "crypto"
import { z } from "zod"
import type { Event } from "../../../setup/event"
import type { Tool, ToolContext } from "../../../agent/tool"
import { LlmModule } from "../../../setup/llm/llm.module"
import { buildLlmConfig } from "../../../setup/llm/buildLlmConfig"
import { createLogger } from "../../../setup/logger"
import { RlmContextClient } from "../data/rlm-context.client"
import type { RlmContextRef, RlmJobResult } from "./rlm.types"

const log = createLogger("rlm")

const DEFAULT_MAX_ITERATIONS = 8
const DEFAULT_TIMEOUT_S = 60
// Cap on how much raw text a single llm_query hands to the sub model - large
// enough for a meaningful chunk, small enough to stay well under any
// provider's context window even on a modest sub model.
const MAX_LLM_QUERY_CHARS = 200_000

function refLabel(ref: RlmContextRef): string {
  if (ref.type === "knowledge") return `knowledge:${ref.knowledgeId}`
  if (ref.type === "source") return `source:${ref.sourceId}`
  return `file:${ref.path}`
}

function describeRef(ref: RlmContextRef): string {
  if (ref.type === "knowledge") return `${refLabel(ref)} (knowledge base - use search/llm_query with a natural-language query, peek is not supported)`
  if (ref.type === "source") return `${refLabel(ref)} (single document)`
  return `${refLabel(ref)} (workspace file)`
}

function decodeContextRefs(): RlmContextRef[] {
  const b64 = process.env.RLM_CONTEXT_REFS_B64
  if (!b64) return []
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as RlmContextRef[]
  } catch (err) {
    log.error("failed to decode RLM_CONTEXT_REFS_B64", err)
    return []
  }
}

function buildSystemPrompt(question: string, refs: RlmContextRef[]): string {
  const refLines = refs.map(r => `- ${describeRef(r)}`).join("\n") || "(none)"
  return (
    `You are the root reasoner of a Recursive Language Model (RLM) run. ` +
    `Ranch's agent decided (or the user forced) that the question below needs ` +
    `reasoning over context too large to fit in one prompt, so it is handed to ` +
    `you as an external environment you explore with tools instead of reading ` +
    `it directly.\n\n` +
    `# Question\n${question}\n\n` +
    `# Available context\n${refLines}\n\n` +
    `# Tools\n` +
    `- peek: read a byte range of a document/file's raw text (not supported for knowledge refs).\n` +
    `- search: for knowledge refs, a semantic query; for document/file refs, a regex search over the raw text.\n` +
    `- llm_query: hand a slice of context (or a knowledge search) to a sub-model and get back a synthesized answer to a specific sub-question. This is your main tool for actually extracting an answer from a chunk - peek/search are for deciding WHERE to look.\n` +
    `- final: call this with your answer when done. You MUST call final before finishing - do not just stop.\n\n` +
    `Be economical: prefer a few well-chosen llm_query calls over many redundant ones.`
  )
}

interface LoopDeps {
  llm: LlmModule
  client: RlmContextClient
  refs: RlmContextRef[]
}

function buildTools(deps: LoopDeps, state: { finalAnswer: string | null }): Tool[] {
  const refByLabel = new Map(deps.refs.map(r => [refLabel(r), r]))
  const textCache = new Map<string, string>()

  async function getCachedText(ref: RlmContextRef & { type: "source" | "agentFile" }): Promise<string> {
    const label = refLabel(ref)
    const cached = textCache.get(label)
    if (cached !== undefined) return cached
    const text = await deps.client.readFullText(ref)
    textCache.set(label, text)
    return text
  }

  const peekTool: Tool = {
    name: "peek",
    description: "Read a byte range of a document/file's raw text. Not supported for knowledge refs - use search or llm_query instead.",
    schema: z.object({
      source_ref: z.string().describe("One of the context refs listed in the system prompt, e.g. \"source:abc123\" or \"file:workspace/log.txt\"."),
      offset: z.number().optional().describe("Byte offset to start reading from. Defaults to 0."),
      limit: z.number().optional().describe("Max characters to return. Defaults to 4000."),
    }),
    async execute(params: unknown): Promise<unknown> {
      const { source_ref, offset = 0, limit = 4000 } = params as { source_ref: string; offset?: number; limit?: number }
      const ref = refByLabel.get(source_ref)
      if (!ref) return { error: `Unknown source_ref "${source_ref}". Available: ${[...refByLabel.keys()].join(", ")}` }
      if (ref.type === "knowledge") return { error: "peek is not supported for knowledge refs - use search or llm_query instead." }
      const text = await getCachedText(ref)
      return { content: text.slice(offset, offset + limit), totalLength: text.length, offset }
    },
  }

  const searchTool: Tool = {
    name: "search",
    description: "For knowledge refs: semantic search. For document/file refs: regex search over the raw text, returning match locations.",
    schema: z.object({
      source_ref: z.string(),
      pattern: z.string().describe("Semantic query (knowledge refs) or a regex pattern (document/file refs)."),
    }),
    async execute(params: unknown): Promise<unknown> {
      const { source_ref, pattern } = params as { source_ref: string; pattern: string }
      const ref = refByLabel.get(source_ref)
      if (!ref) return { error: `Unknown source_ref "${source_ref}". Available: ${[...refByLabel.keys()].join(", ")}` }
      if (ref.type === "knowledge") {
        try {
          return await deps.client.queryKnowledge(ref.knowledgeId, pattern)
        } catch (err) {
          return { error: String(err) }
        }
      }
      const text = await getCachedText(ref)
      let regex: RegExp
      try {
        regex = new RegExp(pattern, "gi")
      } catch (err) {
        return { error: `Invalid regex: ${String(err)}` }
      }
      const matches: Array<{ offset: number; snippet: string }> = []
      let match: RegExpExecArray | null
      const MAX_MATCHES = 20
      while ((match = regex.exec(text)) && matches.length < MAX_MATCHES) {
        const start = Math.max(0, match.index - 80)
        const end = Math.min(text.length, match.index + match[0].length + 80)
        matches.push({ offset: match.index, snippet: text.slice(start, end) })
        if (match[0].length === 0) regex.lastIndex++ // avoid infinite loop on empty matches
      }
      return { matches, totalLength: text.length }
    },
  }

  const llmQueryTool: Tool = {
    name: "llm_query",
    description: "Hand a slice of context (or a knowledge search) to a sub-model and get a synthesized answer to a specific sub-question. Depth-limited: the sub-model cannot call further tools.",
    schema: z.object({
      source_ref: z.string(),
      question: z.string().describe("The specific sub-question to answer from this context."),
      offset: z.number().optional().describe("For document/file refs: byte offset of the slice to hand the sub-model. Omit to use the whole (capped) document."),
      limit: z.number().optional().describe("For document/file refs: length of the slice. Omit to use the whole (capped) document."),
    }),
    async execute(params: unknown): Promise<unknown> {
      const { source_ref, question, offset, limit } = params as {
        source_ref: string; question: string; offset?: number; limit?: number
      }
      const ref = refByLabel.get(source_ref)
      if (!ref) return { error: `Unknown source_ref "${source_ref}". Available: ${[...refByLabel.keys()].join(", ")}` }

      let contextText: string
      if (ref.type === "knowledge") {
        let hits: unknown
        try {
          hits = await deps.client.queryKnowledge(ref.knowledgeId, question)
        } catch (err) {
          return { error: String(err) }
        }
        contextText = typeof hits === "string" ? hits : JSON.stringify(hits, null, 2)
      } else {
        const full = await getCachedText(ref)
        contextText = offset !== undefined || limit !== undefined
          ? full.slice(offset ?? 0, (offset ?? 0) + (limit ?? MAX_LLM_QUERY_CHARS))
          : full
      }
      contextText = contextText.slice(0, MAX_LLM_QUERY_CHARS)

      const subSystemPrompt =
        `Answer the question using ONLY the context below. If the answer isn't in ` +
        `the context, say so explicitly rather than guessing.\n\n# Context\n${contextText}`
      const subHistory: Event[] = [{
        id: randomUUID(),
        type: "user",
        ts: Date.now(),
        data: { text: question, from: "rlm-root" },
      }]
      // No tools passed to the sub model - this is the depth=1 limit: a
      // sub-call answers directly, it cannot itself recurse.
      const response = await deps.llm.auxComplete(subSystemPrompt, subHistory, [])
      return { answer: response.text }
    },
  }

  const finalTool: Tool = {
    name: "final",
    description: "Call this with your final answer to the original question. Ends the run.",
    schema: z.object({
      answer: z.string(),
    }),
    async execute(params: unknown): Promise<unknown> {
      const { answer } = params as { answer: string }
      state.finalAnswer = answer
      return { ok: true }
    },
  }

  return [peekTool, searchTool, llmQueryTool, finalTool]
}

const STUB_TOOL_CONTEXT: Omit<ToolContext, "sessionId" | "agentDir"> = {
  send: async () => {},
}

/**
 * Entry point for RLM_MODE=1 (see index.ts). Runs a single, bounded
 * tool-call loop and prints the result as the LAST line of stdout, valid
 * JSON matching RlmJobResult - Ranch's RlmExecutorGateway reads exactly
 * that line out of this pod's logs. Returns the process exit code.
 */
export async function runRlmJob(): Promise<number> {
  const startedAt = Date.now()
  const jobId = process.env.RLM_JOB_ID ?? "unknown"
  const question = process.env.RLM_QUESTION ?? ""
  const refs = decodeContextRefs()
  const maxIterations = Number(process.env.RLM_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS
  const timeoutS = Number(process.env.RLM_TIMEOUT_S) || DEFAULT_TIMEOUT_S
  const ranchApiUrl = process.env.RANCH_API_URL ?? ""
  const jobToken = process.env.RLM_JOB_TOKEN ?? ""

  log.info(`starting job=${jobId} maxIterations=${maxIterations} timeoutS=${timeoutS} refs=${refs.length}`)

  if (!question || refs.length === 0 || !ranchApiUrl || !jobToken) {
    const result: RlmJobResult = {
      answer: "",
      iterations: 0,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      error: "Missing required RLM_* env vars (question, context refs, API url, or job token).",
    }
    console.log(JSON.stringify(result))
    return 1
  }

  const rootConfig = buildLlmConfig(
    process.env.RLM_ROOT_PROVIDER,
    process.env.RLM_ROOT_MODEL,
    process.env.RLM_ROOT_FALLBACK_MODEL,
    process.env.RLM_ROOT_API_KEY,
  )
  const subConfig = buildLlmConfig(
    process.env.RLM_SUB_PROVIDER || process.env.RLM_ROOT_PROVIDER,
    process.env.RLM_SUB_MODEL,
    process.env.RLM_SUB_FALLBACK_MODEL,
    process.env.RLM_SUB_API_KEY || process.env.RLM_ROOT_API_KEY,
  )
  const llm = new LlmModule(rootConfig, subConfig)
  const client = new RlmContextClient(ranchApiUrl, jobToken)

  const state = { finalAnswer: null as string | null }
  const tools = buildTools({ llm, client, refs }, state)

  const history: Event[] = [{
    id: randomUUID(),
    type: "user",
    ts: Date.now(),
    data: { text: question, from: "rlm-user" },
  }]
  const systemPrompt = buildSystemPrompt(question, refs)

  const deadline = startedAt + timeoutS * 1000
  let iterations = 0
  let toolCallCount = 0
  let lastText = ""

  while (state.finalAnswer === null) {
    iterations++
    if (iterations > maxIterations) {
      log.warn(`hit maxIterations=${maxIterations} without a final() call`)
      break
    }
    if (Date.now() > deadline) {
      log.warn(`hit internal deadline (timeoutS=${timeoutS}) without a final() call`)
      break
    }

    let response
    try {
      response = await llm.complete(systemPrompt, history, tools)
    } catch (err) {
      const result: RlmJobResult = {
        answer: lastText,
        iterations,
        toolCalls: toolCallCount,
        durationMs: Date.now() - startedAt,
        error: `Root LLM call failed: ${String(err)}`,
      }
      console.log(JSON.stringify(result))
      return 1
    }

    if (response.text) lastText = response.text

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        toolCallCount++
        const callEvent: Event = {
          id: randomUUID(), type: "tool_call", ts: Date.now(),
          data: { name: call.name, params: call.params },
        }
        history.push(callEvent)

        const tool = tools.find(t => t.name === call.name)
        let result: unknown
        if (!tool) {
          result = { error: `Unknown tool: ${call.name}` }
        } else {
          try {
            result = await tool.execute(call.params, { ...STUB_TOOL_CONTEXT, sessionId: jobId, agentDir: "." })
          } catch (err) {
            result = { error: String(err) }
          }
        }
        log.info(`iter ${iterations}: ${call.name} -> ${JSON.stringify(result).slice(0, 150)}`)

        const resultEvent: Event = {
          id: randomUUID(), type: "tool_result", ts: Date.now(),
          data: { result },
        }
        history.push(resultEvent)
      }
      // No text-only response and no final() call yet - keep looping.
      if (state.finalAnswer === null) continue
    } else if (response.text) {
      // The paper itself flags FINAL-tag detection as brittle: models
      // sometimes just answer directly without calling the final tool.
      // Accept a plain text-only response as the answer rather than
      // looping forever waiting for a tool call that never comes.
      state.finalAnswer = response.text
    } else {
      // Empty response, no tool calls - nothing more to do.
      break
    }
  }

  const result: RlmJobResult = {
    answer: state.finalAnswer ?? lastText,
    iterations,
    toolCalls: toolCallCount,
    durationMs: Date.now() - startedAt,
    ...(state.finalAnswer === null && !lastText
      ? { error: "RLM run ended without producing an answer (max iterations or timeout reached)." }
      : {}),
  }
  log.info(`done job=${jobId} iterations=${iterations} toolCalls=${toolCallCount} durationMs=${result.durationMs}`)
  console.log(JSON.stringify(result))
  return result.error ? 1 : 0
}
