import { describe, expect, test } from "bun:test"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import { isBrokenConnection, isLostSession, isRefused, nextDelayMs } from "./retryPolicy"

/** No jitter: the middle of the range. */
const mid = () => 0.5

describe("nextDelayMs", () => {
  test("5, 10, 20, 40 seconds, then the ceiling for good", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => nextDelayMs(n, mid, 60_000))).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ])
  })

  test("a server that was never counted waits the first step", () => {
    expect(nextDelayMs(0, mid, 60_000)).toBe(5_000)
  })

  test("moves by at most a fifth either way", () => {
    expect(nextDelayMs(1, () => 0, 60_000)).toBe(4_000)
    expect(nextDelayMs(1, () => 1, 60_000)).toBe(6_000)
    expect(nextDelayMs(9, () => 0, 60_000)).toBe(48_000)
    expect(nextDelayMs(9, () => 1, 60_000)).toBe(72_000)
  })

  test("a lower ceiling caps the early steps too", () => {
    expect(nextDelayMs(4, mid, 15_000)).toBe(15_000)
  })
})

describe("isBrokenConnection", () => {
  test("nothing listening, or the connection went away", () => {
    expect(isBrokenConnection(new Error("connect ECONNREFUSED 10.0.0.1:3000"))).toBe(true)
    expect(isBrokenConnection(new Error("read ECONNRESET"))).toBe(true)
    expect(isBrokenConnection(new TypeError("fetch failed"))).toBe(true)
    expect(isBrokenConnection(new Error("socket hang up"))).toBe(true)
    expect(isBrokenConnection(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(true)
    expect(isBrokenConnection(Object.assign(new Error("failed"), { code: "ConnectionRefused" }))).toBe(true)
  })

  test("a proxy answering for a server that is not there", () => {
    // What the agents logged on 20 November: the ingress's HTML page.
    expect(isBrokenConnection(new StreamableHTTPError(503, "Error POSTing to endpoint: <html><head><title>503</title>"))).toBe(true)
    expect(isBrokenConnection(new StreamableHTTPError(502, "Error POSTing to endpoint: Bad Gateway"))).toBe(true)
    expect(isBrokenConnection(new Error("SSE error: Non-200 status code (HTTP 504)"))).toBe(true)
  })

  test("the cause is looked at", () => {
    const err = new TypeError("request failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })
    expect(isBrokenConnection(err)).toBe(true)
  })

  test("not an answer from the server", () => {
    expect(isBrokenConnection(new StreamableHTTPError(500, "Error POSTing to endpoint: boom"))).toBe(false)
    expect(isBrokenConnection(new StreamableHTTPError(404, "Error POSTing to endpoint: Session not found"))).toBe(false)
    expect(isBrokenConnection(new StreamableHTTPError(401, "Error POSTing to endpoint: Unauthorized"))).toBe(false)
    expect(isBrokenConnection(new Error("MCP error -32602: invalid params"))).toBe(false)
    expect(isBrokenConnection("ECONNREFUSED")).toBe(false)
  })
})

describe("a tool's own error text is not the state of the server", () => {
  test("words a tool relays from somewhere else change nothing", () => {
    const relayed = [
      new McpError(-32000, "fetch failed"),
      new McpError(-32000, "upstream answered ECONNREFUSED"),
      new McpError(-32603, "SSE error: Non-200 status code (HTTP 503)"),
      new McpError(-32000, "SSE error: Non-200 status code (HTTP 401)"),
      new McpError(-32000, "the page said (HTTP 403)"),
      new McpError(-32000, "Session not found"),
    ]
    for (const err of relayed) {
      expect(isBrokenConnection(err)).toBe(false)
      expect(isRefused(err)).toBe(false)
      expect(isLostSession(err)).toBe(false)
    }
  })

  test("the SDK saying the transport closed under a request still counts", () => {
    expect(isBrokenConnection(new McpError(-32000, "Connection closed"))).toBe(true)
  })

  test("a plain error that merely mentions a refusal is not one", () => {
    expect(isRefused(new Error("the page said (HTTP 403)"))).toBe(false)
  })
})

describe("isRefused", () => {
  test("401 and 403, however they arrive", () => {
    expect(isRefused(new StreamableHTTPError(401, "Error POSTing to endpoint: Unauthorized"))).toBe(true)
    expect(isRefused(new StreamableHTTPError(403, "Error POSTing to endpoint: Forbidden"))).toBe(true)
    expect(isRefused(new Error("SSE error: Non-200 status code (HTTP 401)"))).toBe(true)
    expect(isRefused(Object.assign(new Error("nope"), { name: "UnauthorizedError" }))).toBe(true)
  })

  test("not an outage, and not a tool saying no", () => {
    expect(isRefused(new StreamableHTTPError(503, "Error POSTing to endpoint: down"))).toBe(false)
    expect(isRefused(new Error("connect ECONNREFUSED"))).toBe(false)
    expect(isRefused(new Error("MCP error -32000: agent 403 is not yours"))).toBe(false)
  })
})

describe("isLostSession", () => {
  test("still what it was (CLEAN-232)", () => {
    expect(isLostSession(new StreamableHTTPError(404, "Error POSTing to endpoint: Not Found"))).toBe(true)
    expect(isLostSession(new StreamableHTTPError(503, "Error POSTing to endpoint: down"))).toBe(false)
  })
})
