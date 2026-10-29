#!/usr/bin/env bun
// Evaluation runner for the harness principles (CLEAN-150).
//
// Reads every `tests/evals/*.jsonl` (or the files given as arguments), runs
// each case through the assertion mode named in the file header, and prints
// one table. Exits non-zero when a set misses the threshold its header
// declares. The modes land with their user stories; until then a set whose
// mode is unknown is reported as "pending" and does not fail the run.
import { readdirSync, readFileSync } from "fs"
import { join, basename } from "path"
import { z } from "zod"
import { LlmModule } from "../src/slices/setup/llm/llm.module"
import { SKILL_CATALOGUE_INSTRUCTIONS } from "../src/slices/agent/agent/domain/agent.service"
import { InstinctService, DEFAULT_INSTINCT_CONFIG, type IInstinctGateway } from "../src/slices/agent/instinct"
import type { Tool } from "../src/slices/agent/tool/domain/tool.types"
import type { Event } from "../src/slices/setup/event"

interface IEvalHeader { mode: string; threshold: number; description?: string; [key: string]: unknown }
interface IEvalCase { id: string; [key: string]: unknown }
interface IEvalSet { file: string; header: IEvalHeader; cases: IEvalCase[] }

/** `pending` means the mode could not run here (missing credentials); it is reported, not failed. */
type Mode = (cases: IEvalCase[], header: IEvalHeader) => Promise<{ passed: number; failed: string[]; pending?: string }>

/**
 * US2 — the real model sees the example agent's skill catalogue and one
 * message; it must call `skill_load` with the expected skill, or not call it
 * when no skill applies. Needs `LLM_API_KEY` (+ optional `LLM_MODEL`);
 * without credentials the set is reported as pending, not failed.
 */
const skillLoaded: Mode = async (cases, header) => {
  if (!process.env.LLM_API_KEY) return { passed: 0, failed: [], pending: "set LLM_API_KEY to run this set" }
  const skills = (header.skills ?? []) as Array<{ name: string; description: string }>
  // Same model the runtime defaults to, same catalogue wording it ships.
  const llm = new LlmModule({ provider: "claude", apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL ?? "claude-sonnet-4-6" })
  const catalogue = skills.map(s => `- **${s.name}**: ${s.description}`).join("\n")
  const system = `You are a helpful assistant with tools.\n\n# Available Skills\n\n${SKILL_CATALOGUE_INSTRUCTIONS}\n\n${catalogue}`
  const skillLoadTool: Tool = {
    name: "skill_load",
    description: "Load a skill's full instructions for this conversation. Call it when a skill in the catalogue matches what the person needs.",
    schema: z.object({ name: z.string() }),
    execute: async () => ({}),
  }
  const failed: string[] = []
  let falseLoads = 0
  for (const c of cases) {
    const history: Event[] = [{ id: c.id, type: "user", ts: Date.now(), data: { text: String(c.message), from: "eval" } }]
    const response = await llm.getGateway().complete(system, history, [skillLoadTool])
    const loaded = response.toolCalls?.filter(t => t.name === "skill_load").map(t => (t.params as { name?: string })?.name) ?? []
    // `expect` must be loaded (or nothing, when null); `allow` lists skills
    // whose loading is acceptable but not required — a tool-usage question
    // may reasonably pull the tools skill.
    const expect = c.expect as string | null
    const allow = new Set<string>([...(c.allow as string[] | undefined ?? []), ...(expect ? [expect] : [])])
    const unexpected = loaded.filter(n => !n || !allow.has(n))
    const ok = (expect ? loaded.includes(expect) : true) && unexpected.length === 0
    if (!ok) {
      failed.push(`${c.id}→${loaded.join("+") || "none"}`)
      if (!expect && unexpected.length > 0) falseLoads++
    }
  }
  const maxFalse = Number(header.maxFalseLoadPct ?? 100)
  const falsePct = Math.round((falseLoads / Math.max(1, cases.filter(c => !c.expect).length)) * 100)
  if (falsePct > maxFalse) failed.push(`false loads ${falsePct}% > ${maxFalse}%`)
  return { passed: cases.length - failed.filter(f => !f.startsWith("false loads")).length, failed }
}

/**
 * US3 — one instinct at its post-correction confidence (apply band) is
 * rendered into the prompt; the model's next move on a matching message must
 * follow it: the expected tool call (or none), text that matches / avoids a
 * regex, or a sentence cap. Needs `LLM_API_KEY`.
 */
const holdsAfterCorrection: Mode = async (cases) => {
  if (!process.env.LLM_API_KEY) return { passed: 0, failed: [], pending: "set LLM_API_KEY to run this set" }
  const llm = new LlmModule({ provider: "claude", apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL ?? "claude-sonnet-4-6" })
  const stub = (name: string, description: string): Tool => ({ name, description, effect: "write", schema: z.object({ agent: z.string().optional() }), execute: async () => ({}) })
  const tools = [
    stub("ranch__list_agents", "List every agent on the ranch with its state."),
    stub("ranch__restart_agent", "Restart one agent by name or id."),
    stub("ranch__delete_agent", "Delete one agent by name or id."),
  ]
  const failed: string[] = []
  for (const c of cases) {
    const spec = c.instinct as { trigger: string; action: string; source: "correction" }
    const service = new InstinctService(nullInstinctGateway(), DEFAULT_INSTINCT_CONFIG)
    service.create({ trigger: spec.trigger, action: spec.action, source: spec.source, evidence: [{ ref: "session:eval", ts: Date.now() }] })
    const system = `You are a helpful operations assistant with tools. Be concise.\n\n# Learned from experience\n\n${service.render()}`
    const history: Event[] = [{ id: c.id, type: "user", ts: Date.now(), data: { text: String(c.message), from: "eval" } }]
    const response = await llm.getGateway().complete(system, history, tools)
    const expect = c.expect as { toolCall?: string | null; contains?: string; notContains?: string; maxSentences?: number }
    const calls = response.toolCalls?.map(t => t.name) ?? []
    const text = response.text ?? ""
    const problems: string[] = []
    if (expect.toolCall === null && calls.length > 0) problems.push(`called ${calls.join("+")}`)
    if (typeof expect.toolCall === "string" && !calls.includes(expect.toolCall)) problems.push(`no ${expect.toolCall}`)
    if (expect.contains && !re(expect.contains).test(text)) problems.push("text mismatch")
    if (expect.notContains && re(expect.notContains).test(text)) problems.push("forbidden text")
    if (expect.maxSentences !== undefined && (text.match(/[.!?](\s|$)/g)?.length ?? 1) > expect.maxSentences) problems.push("too long")
    if (problems.length) failed.push(`${c.id}(${problems.join(";")})`)
  }
  return { passed: cases.length - failed.length, failed }
}

/** Case patterns may start with `(?i)` for case-insensitive matching (JS has no inline flags). */
function re(pattern: string): RegExp {
  return pattern.startsWith("(?i)") ? new RegExp(pattern.slice(4), "iu") : new RegExp(pattern, "u")
}

function nullInstinctGateway(): IInstinctGateway {
  return { list: () => [], write: () => {}, remove: () => {}, readLastDecay: () => undefined, writeLastDecay: () => {}, writeSkill: () => "" }
}

/** Assertion modes, one per story. */
const MODES: Record<string, Mode> = { "skill-loaded": skillLoaded, "holds-after-correction": holdsAfterCorrection }

function loadSet(file: string): IEvalSet {
  const lines = readFileSync(file, "utf8").split("\n").filter(l => l.trim())
  const header = JSON.parse(lines[0] ?? "{}") as IEvalHeader
  const cases = lines.slice(1).map(l => JSON.parse(l) as IEvalCase)
  return { file, header, cases }
}

function discover(args: string[]): string[] {
  if (args.length > 0) return args
  const dir = join(import.meta.dir, "..", "tests", "evals")
  try {
    return readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => join(dir, f))
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const sets = discover(process.argv.slice(2)).map(loadSet)
  if (sets.length === 0) {
    console.log("no eval sets under tests/evals/")
    return
  }
  let failures = 0
  const rows: string[][] = [["set", "mode", "cases", "pass", "rate", "threshold", "status"]]
  for (const set of sets) {
    const mode = MODES[set.header.mode]
    if (!mode) {
      rows.push([basename(set.file), set.header.mode, String(set.cases.length), "-", "-", `${set.header.threshold}%`, "pending"])
      continue
    }
    const result = await mode(set.cases, set.header)
    if (result.pending) {
      rows.push([basename(set.file), set.header.mode, String(set.cases.length), "-", "-", `${set.header.threshold}%`, `pending (${result.pending})`])
      continue
    }
    const rate = set.cases.length === 0 ? 0 : Math.round((result.passed / set.cases.length) * 100)
    const ok = rate >= set.header.threshold && !result.failed.some(f => f.startsWith("false loads"))
    if (!ok) failures++
    const shown = process.env.EVAL_VERBOSE ? result.failed : result.failed.slice(0, 3)
    rows.push([basename(set.file), set.header.mode, String(set.cases.length), String(result.passed), `${rate}%`, `${set.header.threshold}%`, ok ? "ok" : `FAIL (${shown.join(", ")})`])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  "))
  if (failures > 0) process.exit(1)
}

await main()
