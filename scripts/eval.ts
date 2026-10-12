#!/usr/bin/env bun
// Evaluation runner for the harness principles (CLEAN-150).
//
// Reads every `tests/evals/*.jsonl` (or the files given as arguments), runs
// each case through the assertion mode named in the file header, and prints
// one table. Exits non-zero when a set misses the threshold its header
// declares. The modes land with their user stories; until then a set whose
// mode is unknown is reported as "pending" and does not fail the run.
import { mkdtempSync, readdirSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join, basename } from "path"
import { z } from "zod"
import { GuardModule } from "../src/slices/agent/guard"
import { AGENT_CONFIG_DEFAULTS } from "../src/slices/runtime/init/domain/init.types"
import { LlmModule } from "../src/slices/setup/llm/llm.module"
import { SKILL_CATALOGUE_INSTRUCTIONS } from "../src/slices/agent/agent/domain/agent.service"
import type { Tool } from "../src/slices/agent/tool/domain/tool.types"
import type { Event } from "../src/slices/setup/event"

interface IEvalHeader { mode: string; threshold: number; description?: string; [key: string]: unknown }
interface IEvalCase { id: string; [key: string]: unknown }
interface IEvalSet { file: string; header: IEvalHeader; cases: IEvalCase[] }

/** `pending` means the mode could not run here (missing credentials); it is reported, not failed. */
type Mode = (cases: IEvalCase[], header: IEvalHeader) => Promise<{ passed: number; failed: string[]; pending?: string }>

/**
 * US1 — every case carries the tool call the model would make; the baseline
 * rules (plus `.agent/rules/` when AGENT_DIR is set) must block it.
 */
const blocked: Mode = async (cases) => {
  const agentDir = process.env.AGENT_DIR ?? mkdtempSync(join(tmpdir(), "eval-guard-"))
  const guard = new GuardModule(agentDir, AGENT_CONFIG_DEFAULTS.guard)
  await guard.load()
  const failed: string[] = []
  for (const c of cases) {
    const call = c.call as { name: string; params: unknown }
    const verdict = guard.before({ tool: call.name, params: call.params, agentDir: "/agent", sessionId: "eval", turnId: c.id, effect: "write" })
    if (verdict.kind !== "block") failed.push(c.id)
  }
  return { passed: cases.length - failed.length, failed }
}

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

/** Assertion modes, one per story (US3 holds-after-correction and US5 no-false-done land with theirs). */
const MODES: Record<string, Mode> = { blocked, "skill-loaded": skillLoaded }

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
