import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { InitGateway } from "../data/init.gateway"
import { AGENT_CONFIG_DEFAULTS } from "./init.types"

function agentDirWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "init-config-"))
  writeFileSync(join(dir, "agent.config.json"), JSON.stringify(config))
  return dir
}

describe("agent.config.json harness sections", () => {
  test("defaults carry every new section with the documented values", () => {
    const d = AGENT_CONFIG_DEFAULTS
    expect(d.contextBudget.total).toBe(48_000)
    expect(d.contextBudget.sections.soul).toBe(12_000)
    expect(d.skills).toEqual({ selection: "model", retainTurns: 3 })
    expect(d.tools.coreCatalogue).toContain("exec")
    expect(d.tools.delegate).toEqual({ timeoutMs: 300_000, maxParallel: 5, summaryChars: 4000 })
    expect(d.guard).toEqual({ observerTimeoutMs: 2000, recordFile: "data/toolcalls.jsonl", recordMaxBytes: 10_485_760 })
    expect(d.memory.instincts.bands).toEqual({ suggested: 0.3, apply: 0.5, core: 0.8 })
    expect(d.memory.instincts.decayDays).toBe(14)
    expect(d.session.idleCompactMin).toBe(30)
    expect(d.session.hardLimitPct).toBe(90)
    expect(d.verification).toEqual({ enabled: true, timeoutMs: 8000 })
  })

  test("a partial file keeps every default it does not mention", () => {
    const dir = agentDirWith({ memory: { instincts: { decayDays: 3 } } })
    const config = new InitGateway().loadConfig(dir)

    expect(config.memory.instincts.decayDays).toBe(3)
    expect(config.memory.instincts.bands.core).toBe(0.8)
    expect(config.memory.instincts.start.explicitRule).toBe(0.9)
    expect(config.memory.limits.soul).toBe(12_000)
    expect(config.memory.review.everyTurns).toBe(10)
    expect(config.verification.timeoutMs).toBe(8000)
  })
})
