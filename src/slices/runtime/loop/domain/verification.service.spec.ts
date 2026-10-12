import { describe, expect, test } from "bun:test"
import { VerificationService } from "./verification.service"
import { buildVerificationPrompt, parseVerification } from "./prompts/verification.prompt"

function aux(answer: string | (() => Promise<string>)) {
  const prompts: string[] = []
  return {
    prompts,
    deps: {
      auxComplete: async (system: string) => {
        prompts.push(system)
        const text = typeof answer === "string" ? answer : await answer()
        return { text }
      },
    },
  }
}

const failedWrite = [{ tool: "http", outcome: "error" as const, result: '{"error":"500 Internal Server Error"}' }]

describe("VerificationService (CLEAN-150 US5)", () => {
  test("a supported claim passes", async () => {
    const { deps } = aux('{"ok":true}')
    const v = await new VerificationService(deps, { enabled: true, timeoutMs: 1000 }).verify("Updated the agent name.", [{ tool: "http", outcome: "ok", result: '{"status":200}' }])
    expect(v).toMatchObject({ ok: true, timedOut: false, skipped: false })
  })

  test("an unsupported claim comes back rewritten", async () => {
    const { deps, prompts } = aux('{"ok":false,"reply":"The update failed: the API returned 500 Internal Server Error."}')
    const v = await new VerificationService(deps, { enabled: true, timeoutMs: 1000 }).verify("Done — the agent name is updated.", failedWrite)
    expect(v.ok).toBe(false)
    expect(v.reply).toContain("500")
    expect(prompts[0]).toContain("http → error")
    expect(prompts[0]).toContain("Done — the agent name is updated.")
  })

  test("past timeoutMs the draft is kept and marked timed out", async () => {
    const { deps } = aux(() => new Promise<string>(res => setTimeout(() => res('{"ok":false,"reply":"late"}'), 300)))
    const v = await new VerificationService(deps, { enabled: true, timeoutMs: 20 }).verify("Done.", failedWrite)
    expect(v).toMatchObject({ ok: true, timedOut: true, skipped: false })
    expect(v.reply).toBeUndefined()
  })

  test("no mutating outcomes, disabled, or an empty draft → skipped without calling the model", async () => {
    const { deps, prompts } = aux('{"ok":false,"reply":"x"}')
    const svc = new VerificationService(deps, { enabled: true, timeoutMs: 1000 })
    expect((await svc.verify("Done.", [])).skipped).toBe(true)
    expect((await svc.verify("", failedWrite)).skipped).toBe(true)
    expect((await new VerificationService(deps, { enabled: false, timeoutMs: 1000 }).verify("Done.", failedWrite)).skipped).toBe(true)
    expect(prompts).toHaveLength(0)
  })

  test("an unparseable or failing verifier never blocks the reply", async () => {
    expect((await new VerificationService(aux("I think it is fine").deps, { enabled: true, timeoutMs: 1000 }).verify("Done.", failedWrite))).toMatchObject({ ok: true, skipped: true })
    const throwing = { auxComplete: async () => { throw new Error("aux down") } }
    expect((await new VerificationService(throwing, { enabled: true, timeoutMs: 1000 }).verify("Done.", failedWrite))).toMatchObject({ ok: true, skipped: true })
  })
})

describe("verification prompt helpers", () => {
  test("parseVerification accepts both shapes and rejects the rest", () => {
    expect(parseVerification('{"ok":true}')).toEqual({ ok: true })
    expect(parseVerification('Sure: {"ok":false,"reply":"It failed."}')).toEqual({ ok: false, reply: "It failed." })
    expect(parseVerification('{"ok":false}')).toBeNull()
    expect(parseVerification("nope")).toBeNull()
  })

  test("a fenced answer followed by prose with braces still parses", () => {
    const answer = '```json\n{"ok": true}\n```\n\nThe request returned {"status":200,"name":"Billing"} so the claim holds.'
    expect(parseVerification(answer)).toEqual({ ok: true })
    const rewrite = '{"ok":false,"reply":"The call failed with {\\"error\\":\\"500\\"}."} — note the braces inside the string.'
    expect(parseVerification(rewrite)).toEqual({ ok: false, reply: 'The call failed with {"error":"500"}.' })
  })

  test("the prompt lists every outcome with its preview", () => {
    const p = buildVerificationPrompt([{ tool: "exec", outcome: "blocked", result: "blocked by rule x" }, { tool: "file", outcome: "ok", result: "" }], "Done.")
    expect(p).toContain("1. exec → blocked: blocked by rule x")
    expect(p).toContain("2. file → ok")
  })
})
