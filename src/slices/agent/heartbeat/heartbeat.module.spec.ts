import { describe, expect, test } from "bun:test"
import { resolveIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS } from "./heartbeat.module"

describe("resolveIntervalMs", () => {
  test("passes valid positive intervals through", () => {
    expect(resolveIntervalMs(180 * 60 * 1000)).toBe(180 * 60 * 1000)
    expect(resolveIntervalMs(60_000)).toBe(60_000)
  })

  test("zero and negative fall back to the default", () => {
    expect(resolveIntervalMs(0)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
    expect(resolveIntervalMs(-5 * 60 * 1000)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
  })

  test("non-finite values fall back to the default", () => {
    expect(resolveIntervalMs(NaN)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
    expect(resolveIntervalMs(Infinity)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
    expect(resolveIntervalMs(-Infinity)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
  })

  test("undefined and non-numeric fall back to the default", () => {
    expect(resolveIntervalMs(undefined)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
    expect(resolveIntervalMs("30" as unknown as number)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
  })

  test("default is 30 minutes", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(30 * 60 * 1000)
  })
})
