import { describe, expect, test } from "bun:test"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { LATER_DROP_MS, nextPhaseCheckAt, phaseOf, redactError, type IToolServerState } from "./toolState"

const START = Date.parse("2026-11-20T09:09:52.000Z")
const GRACE = 60_000

const server = (state: IToolServerState["state"], sinceMs = START, name = "Documents"): IToolServerState => ({
  name,
  state,
  since: new Date(sinceMs).toISOString(),
  attempts: state === "connected" ? 0 : 1,
})

describe("phaseOf", () => {
  test("no servers, or all connected: ready", () => {
    expect(phaseOf([], START, START + 1_000, GRACE)).toBe("ready")
    expect(phaseOf([server("connected"), server("connected", START, "Ranch")], START, START + 1_000, GRACE)).toBe("ready")
  })

  test("a server still being tried within the waiting limit: connecting", () => {
    expect(phaseOf([server("connected", START, "Ranch"), server("retrying")], START, START + 59_999, GRACE)).toBe("connecting")
  })

  test("the same server once the limit has passed: limited", () => {
    expect(phaseOf([server("retrying")], START, START + GRACE, GRACE)).toBe("limited")
  })

  test("a refused server is limited at once: waiting changes nothing", () => {
    expect(phaseOf([server("refused")], START, START + 1_000, GRACE)).toBe("limited")
    expect(phaseOf([server("refused")], START, START + GRACE * 10, GRACE)).toBe("limited")
  })

  test("refused beside one still being tried: connecting until the limit", () => {
    const servers = [server("refused", START, "Ranch"), server("retrying")]
    expect(phaseOf(servers, START, START + 1_000, GRACE)).toBe("connecting")
    expect(phaseOf(servers, START, START + GRACE, GRACE)).toBe("limited")
  })

  test("a later drop is not a mark for its first fifteen seconds", () => {
    const droppedAt = START + 3_600_000
    const servers = [server("retrying", droppedAt)]
    expect(phaseOf(servers, START, droppedAt + LATER_DROP_MS - 1, GRACE)).toBe("ready")
    expect(phaseOf(servers, START, droppedAt + LATER_DROP_MS, GRACE)).toBe("limited")
  })
})

describe("nextPhaseCheckAt", () => {
  test("nothing being tried: only a server can change it", () => {
    expect(nextPhaseCheckAt([server("connected")], START, START + 1, GRACE)).toBeNull()
    expect(nextPhaseCheckAt([server("refused")], START, START + 1, GRACE)).toBeNull()
  })

  test("within the limit: at the limit", () => {
    expect(nextPhaseCheckAt([server("retrying")], START, START + 1_000, GRACE)).toBe(START + GRACE)
  })

  test("a later drop: when it stops being forgiven", () => {
    const droppedAt = START + 3_600_000
    expect(nextPhaseCheckAt([server("retrying", droppedAt)], START, droppedAt + 1_000, GRACE)).toBe(droppedAt + LATER_DROP_MS)
    expect(nextPhaseCheckAt([server("retrying", droppedAt)], START, droppedAt + LATER_DROP_MS, GRACE)).toBeNull()
  })
})

describe("redactError", () => {
  test("a proxy's HTML page becomes its status code", () => {
    const err = new StreamableHTTPError(503, "Error POSTing to endpoint: <html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>")
    expect(redactError(err)).toBe("HTTP 503")
    expect(redactError(new Error("<!DOCTYPE html><html>oops"))).toBe("the server answered with an error page")
  })

  test("the first line only, cut to 300 characters", () => {
    expect(redactError(new Error("connect ECONNREFUSED 10.0.0.1:3000\n    at stack"))).toBe("connect ECONNREFUSED 10.0.0.1:3000")
    const long = redactError(new Error("x".repeat(500)))
    expect(long.length).toBe(300)
    expect(long.endsWith("…")).toBe(true)
  })

  test("nothing that could be a credential", () => {
    expect(redactError(new Error("401 for Authorization: Bearer abc.def-123"))).not.toContain("abc.def-123")
    expect(redactError(new Error("sent Bearer sk-live-9f8e7d to the server"))).not.toContain("sk-live-9f8e7d")
    expect(redactError(new Error("GET https://user:hunter2@api.test/mcp?token=s3cret&x=1 failed"))).toBe("GET https://api.test/mcp failed")
    expect(redactError(new Error('headers {"x-api-key":"k-12345"} refused'))).not.toContain("k-12345")
  })

  test("not an Error", () => {
    expect(redactError("boom")).toBe("boom")
    expect(redactError(undefined)).toBe("")
  })
})
