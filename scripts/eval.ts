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
import { GuardModule } from "../src/slices/agent/guard"
import { AGENT_CONFIG_DEFAULTS } from "../src/slices/runtime/init/domain/init.types"

interface IEvalHeader { mode: string; threshold: number; description?: string }
interface IEvalCase { id: string; [key: string]: unknown }
interface IEvalSet { file: string; header: IEvalHeader; cases: IEvalCase[] }

type Mode = (cases: IEvalCase[]) => Promise<{ passed: number; failed: string[] }>

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

/** Assertion modes, one per story (US2 skill-loaded, US3 holds-after-correction, US5 no-false-done land with theirs). */
const MODES: Record<string, Mode> = { blocked }

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
    const result = await mode(set.cases)
    const rate = set.cases.length === 0 ? 0 : Math.round((result.passed / set.cases.length) * 100)
    const ok = rate >= set.header.threshold
    if (!ok) failures++
    rows.push([basename(set.file), set.header.mode, String(set.cases.length), String(result.passed), `${rate}%`, `${set.header.threshold}%`, ok ? "ok" : `FAIL (${result.failed.slice(0, 3).join(", ")})`])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  "))
  if (failures > 0) process.exit(1)
}

await main()
