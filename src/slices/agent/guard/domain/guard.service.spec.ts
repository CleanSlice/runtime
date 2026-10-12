import { describe, expect, test } from "bun:test"
import { GuardService, GuardLoadError, parseRule } from "./guard.service"
import type { IGuardGateway } from "./guard.gateway"
import type { IGuardCall, IRuleFile, IToolCallRecord } from "./guard.types"

function ruleFile(data: Record<string, unknown>, source: "baseline" | "agent" = "agent", body = "Because."): IRuleFile {
  return { file: `${source}/${String(data.id ?? "x")}.md`, source, data, body }
}

function gateway(files: IRuleFile[], opts: { failRecord?: boolean; slowRecordMs?: number } = {}) {
  const records: IToolCallRecord[] = []
  const gw: IGuardGateway = {
    loadRuleFiles: () => files,
    appendRecord: async (r) => {
      if (opts.failRecord) throw new Error("disk full")
      if (opts.slowRecordMs) await new Promise(res => setTimeout(res, opts.slowRecordMs))
      records.push(r)
    },
  }
  return { gw, records }
}

const call = (over: Partial<IGuardCall> = {}): IGuardCall => ({
  tool: "exec",
  params: { command: "cat data/secrets/x" },
  agentDir: "/agent",
  sessionId: "s",
  turnId: "t",
  effect: "write",
  ...over,
})

const blockSecrets = ruleFile({
  id: "no-secret-store-reads", event: "before", action: "block", protected: true,
  match: { tool: "exec|file", arg: { path: "$", pattern: "data/secrets" } },
}, "baseline", "The secret store is read only through secret_get.")
const redactAll = ruleFile({ id: "redact-credentials", event: "after", action: "redact", protected: true, match: { tool: "*" } }, "baseline")
const recordAll = ruleFile({ id: "record-all", event: "after", action: "record", protected: true, match: { tool: "*" } }, "baseline")

async function loaded(files: IRuleFile[], opts?: Parameters<typeof gateway>[1]) {
  const { gw, records } = gateway(files, opts)
  const guard = new GuardService(gw, { observerTimeoutMs: 50 })
  await guard.load()
  return { guard, records }
}

describe("parseRule", () => {
  test("accepts a well-formed rule and carries the body as the reason", () => {
    const rule = parseRule(blockSecrets)
    expect(rule.id).toBe("no-secret-store-reads")
    expect(rule.enabled).toBe(true)
    expect(rule.reason).toContain("secret_get")
  })

  test.each([
    [{ event: "before", action: "block", match: { tool: "exec" } }, /id/],
    [{ id: "Bad Id", event: "before", action: "block", match: { tool: "exec" } }, /id/],
    [{ id: "xx", event: "sometime", action: "block", match: { tool: "exec" } }, /event/],
    [{ id: "xx", event: "before", action: "explode", match: { tool: "exec" } }, /action/],
    [{ id: "xx", event: "before", action: "block" }, /match/],
    [{ id: "xx", event: "after", action: "record", match: { tool: "exec", arg: { path: "$", pattern: "a" } } }, /arg.*before/],
    [{ id: "xx", event: "before", action: "block", match: { tool: "exec", result: "a" } }, /result.*after/],
    [{ id: "xx", event: "before", action: "block", match: { tool: "exec", arg: { path: "$", pattern: "(" } } }, /pattern/],
  ])("rejects %j naming the field", (data, re) => {
    expect(() => parseRule(ruleFile(data as Record<string, unknown>))).toThrow(re)
  })

  test("agent files cannot declare protected", () => {
    const rule = parseRule(ruleFile({ id: "xx", event: "before", action: "block", protected: true, match: { tool: "exec" } }, "agent"))
    expect(rule.protected).toBe(false)
  })
})

describe("GuardService.load", () => {
  test("a malformed file fails the whole load, naming file and problem", async () => {
    const { gw } = gateway([blockSecrets, ruleFile({ id: "broken", event: "before", match: { tool: "exec" } })])
    const guard = new GuardService(gw, { observerTimeoutMs: 50 })
    await expect(guard.load()).rejects.toBeInstanceOf(GuardLoadError)
    await expect(guard.load()).rejects.toThrow(/agent\/broken\.md.*action/)
  })

  test("a file whose frontmatter did not parse is reported the same way", async () => {
    const { gw } = gateway([{ file: "agent/bad.md", source: "agent", data: {}, body: "", error: "bad indentation" }])
    await expect(new GuardService(gw, { observerTimeoutMs: 50 }).load()).rejects.toThrow(/agent\/bad\.md.*bad indentation/)
  })

  test("an agent rule cannot override a protected baseline rule of the same id", async () => {
    const override = ruleFile({ id: "no-secret-store-reads", event: "before", action: "record", match: { tool: "exec" } }, "agent")
    const { gw } = gateway([blockSecrets, override])
    await expect(new GuardService(gw, { observerTimeoutMs: 50 }).load()).rejects.toThrow(/protected/)
  })

  test("an agent rule may override an unprotected baseline rule", async () => {
    const base = ruleFile({ id: "soft", event: "before", action: "block", match: { tool: "exec" } }, "baseline")
    const override = ruleFile({ id: "soft", event: "before", action: "record", enabled: false, match: { tool: "exec" } }, "agent")
    const { guard } = await loaded([base, override])
    expect(guard.listRules().find(r => r.id === "soft")?.source).toBe("agent")
    expect(guard.before(call({ params: { command: "ls" } })).kind).toBe("allow")
  })

  test("a failed load leaves the previous rule set in place", async () => {
    const files: IRuleFile[] = [blockSecrets]
    const { gw } = gateway(files)
    const guard = new GuardService(gw, { observerTimeoutMs: 50 })
    await guard.load()
    files.push(ruleFile({ id: "broken" }))
    await expect(guard.load()).rejects.toThrow()
    expect(guard.listRules().map(r => r.id)).toEqual(["no-secret-store-reads"])
    expect(guard.before(call()).kind).toBe("block")
  })
})

describe("GuardService.before", () => {
  test("blocks a matching call with the rule id and reason, allows the rest", async () => {
    const { guard } = await loaded([blockSecrets])
    const verdict = guard.before(call())
    expect(verdict).toMatchObject({ kind: "block", ruleId: "no-secret-store-reads" })
    expect((verdict as { reason: string }).reason).toContain("secret_get")
    expect(guard.before(call({ params: { command: "ls" } })).kind).toBe("allow")
    expect(guard.before(call({ tool: "http", params: { url: "https://x/data/secrets" } })).kind).toBe("allow")
  })

  test("disabled rules do not fire", async () => {
    const { guard } = await loaded([ruleFile({ ...blockSecrets.data, enabled: false, protected: false })])
    expect(guard.before(call()).kind).toBe("allow")
  })

  test("block wins over redact and record on the same call", async () => {
    const redactArgs = ruleFile({ id: "redact-args", event: "before", action: "redact", match: { tool: "*" } })
    const recordBefore = ruleFile({ id: "note", event: "before", action: "record", match: { tool: "*" } })
    const { guard } = await loaded([recordBefore, redactArgs, blockSecrets])
    expect(guard.before(call()).kind).toBe("block")
  })

  test("a before redact rule masks credential-shaped strings in the params", async () => {
    const redactArgs = ruleFile({ id: "redact-args", event: "before", action: "redact", match: { tool: "*" } })
    const { guard } = await loaded([redactArgs])
    const verdict = guard.before(call({ params: { command: "echo sk-ant-oat01-abcdefghijklmnop" } }))
    expect(verdict.kind).toBe("allow")
    expect(JSON.stringify((verdict as { params: unknown }).params)).not.toContain("abcdefghijklmnop")
    expect((verdict as { rulesFired: string[] }).rulesFired).toEqual(["redact-args"])
  })

  test("without a successful load every call is blocked with the load error", async () => {
    const { gw } = gateway([])
    const guard = new GuardService(gw, { observerTimeoutMs: 50 })
    guard.markFailed("rules/x.md: missing action")
    const verdict = guard.before(call({ params: { command: "ls" } }))
    expect(verdict).toMatchObject({ kind: "block", ruleId: "rules-not-loaded" })
    expect((verdict as { reason: string }).reason).toContain("missing action")
  })
})

describe("GuardService.after", () => {
  test("redacts credentials in the result and says so", async () => {
    const { guard } = await loaded([redactAll])
    const verdict = await guard.after(call({ tool: "http" }), { body: "Bearer abcdefghijklmnopqrstuvwxyz" }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    expect(verdict.redacted).toBe(true)
    expect(JSON.stringify(verdict.result)).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(verdict.rulesFired).toEqual(["redact-credentials"])
  })

  test("leaves a clean result untouched and reports no redaction", async () => {
    const { guard } = await loaded([redactAll])
    const verdict = await guard.after(call(), { content: "hello" }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    expect(verdict.redacted).toBe(false)
    expect(verdict.result).toEqual({ content: "hello" })
  })

  test("a result rule only redacts when the result matches", async () => {
    const onlyTokens = ruleFile({ id: "rr", event: "after", action: "redact", match: { tool: "*", result: "ghp_" } })
    const { guard } = await loaded([onlyTokens])
    const miss = await guard.after(call(), { content: "Bearer abcdefghijklmnopqrstuvwxyz" }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    expect(miss.redacted).toBe(false)
    const hit = await guard.after(call(), { content: "ghp_abcdefghijklmnopqrstuvwxyz1234" }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    expect(hit.redacted).toBe(true)
  })

  test("record rules append one record per call with outcome, sizes and rules fired", async () => {
    const { guard, records } = await loaded([blockSecrets, recordAll])
    const verdict = guard.before(call())
    await guard.after(call(), { error: "blocked" }, { outcome: "blocked", durationMs: 0, rulesFired: verdict.kind === "block" ? [verdict.ruleId] : [] })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tool: "exec", outcome: "blocked", sessionId: "s", turnId: "t", effect: "write", redacted: false })
    expect(records[0]!.rulesFired).toEqual(["no-secret-store-reads", "record-all"])
    expect(records[0]!.paramsChars).toBeGreaterThan(0)
  })

  test("a failing observer never changes the result and is logged once", async () => {
    const { guard } = await loaded([recordAll], { failRecord: true })
    const a = await guard.after(call(), { ok: 1 }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    const b = await guard.after(call(), { ok: 2 }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    expect(a.result).toEqual({ ok: 1 })
    expect(b.result).toEqual({ ok: 2 })
    expect(guard.observerFailures()).toEqual({ "record-all": 2 })
  })

  test("a slow observer is abandoned at observerTimeoutMs", async () => {
    const { guard } = await loaded([recordAll], { slowRecordMs: 500 })
    const started = Date.now()
    await guard.after(call(), { ok: 1 }, { outcome: "ok", durationMs: 1, rulesFired: [] })
    expect(Date.now() - started).toBeLessThan(400)
  })

  test("recentFirings counts rules by id within the window", async () => {
    const { guard } = await loaded([blockSecrets, recordAll])
    for (let i = 0; i < 3; i++) {
      const v = guard.before(call())
      await guard.after(call(), {}, { outcome: "blocked", durationMs: 0, rulesFired: v.kind === "block" ? [v.ruleId] : [] })
    }
    expect(guard.recentFirings(24)).toEqual([
      { id: "no-secret-store-reads", times: 3 },
      { id: "record-all", times: 3 },
    ])
  })
})

describe("GuardService.redactOutgoing", () => {
  test("masks credentials in reply text when a wildcard redact rule is active", async () => {
    const { guard } = await loaded([redactAll])
    expect(guard.redactOutgoing("key sk-ant-oat01-abcdefghijklmnop ok")).not.toContain("abcdefghijklmnop")
  })

  test("is a no-op without such a rule", async () => {
    const { guard } = await loaded([blockSecrets])
    expect(guard.redactOutgoing("key sk-ant-oat01-abcdefghijklmnop ok")).toContain("abcdefghijklmnop")
  })
})

describe("GuardService.redactStreaming", () => {
  test("holds back a tail that is the start of a credential, then masks it once complete", async () => {
    const { guard } = await loaded([redactAll])
    expect(guard.redactStreaming("your key is sk-ant-oa")).toBe("your key is ")
    // Long enough for redact() itself: masked rather than held.
    expect(guard.redactStreaming("your key is sk-ant-oat01-abc")).toBe("your key is sk-ant…bc")
    expect(guard.redactStreaming("your key is sk-ant-oat01-abcdefghijklmnop, keep it")).toBe("your key is sk-ant…op, keep it")
    expect(guard.redactStreaming("token: Bearer abcd")).toBe("token: ")
    expect(guard.redactStreaming("id 12345678:abc")).toBe("id ")
  })

  test("ordinary text streams through untouched, including a masked token at the end", async () => {
    const { guard } = await loaded([redactAll])
    expect(guard.redactStreaming("all good, nothing to see")).toBe("all good, nothing to see")
    expect(guard.redactStreaming("key sk-ant-oat01-abcdefghijklmnop")).toBe("key sk-ant…op")
  })

  test("is a no-op without a wildcard redact rule", async () => {
    const { guard } = await loaded([blockSecrets])
    expect(guard.redactStreaming("your key is sk-ant-oat01-abc")).toBe("your key is sk-ant-oat01-abc")
  })
})
