import { describe, expect, test } from "bun:test"
import type { Event } from "../../../setup/event"
import { capPayload, fitEventsToBudget, sizeOf } from "./contextBudget"

/**
 * The model's window is made of characters, not of events or strings
 * (CLEAN-124). A catalogue of a thousand short entries passed every
 * per-string check and still blew the window; these pin the total caps.
 */
describe("capPayload", () => {
  test("hands back the same object when it already fits", () => {
    const value = { results: [{ name: "a" }, { name: "b" }] }
    expect(capPayload(value, 1_000)).toBe(value)
  })

  test("drops the tail of a long array and says how many items are missing", () => {
    const items = Array.from({ length: 2_000 }, (_, i) => ({ name: `tool-${i}`, description: "does a thing" }))
    const capped = capPayload({ results: items }, 4_000) as { results: unknown[] }

    expect(sizeOf(capped)).toBeLessThanOrEqual(4_000)
    const last = capped.results[capped.results.length - 1]
    expect(typeof last).toBe("string")
    expect(last as string).toMatch(/^…\[truncated: \d+ more items omitted\]$/)
    // Most of the budget went to real items, not to the note.
    expect(capped.results.length).toBeGreaterThan(50)
  })

  test("cuts a single long string with the +N marker", () => {
    const capped = capPayload("x".repeat(10_000), 500) as string
    expect(capped.length).toBeLessThanOrEqual(500)
    expect(capped).toMatch(/…\[truncated \+\d+ chars\]$/)
  })

  test("caps nested arrays inside objects and keeps the leading fields", () => {
    const value = {
      ok: true,
      rows: Array.from({ length: 500 }, (_, i) => ({ id: i, text: "row ".repeat(20) })),
      after: "kept?",
    }
    const capped = capPayload(value, 3_000) as Record<string, unknown>
    expect(sizeOf(capped)).toBeLessThanOrEqual(3_000)
    expect(capped.ok).toBe(true)
    expect(Array.isArray(capped.rows)).toBe(true)
  })

  test("leaves numbers, booleans and null alone", () => {
    expect(capPayload(42, 1)).toBe(42)
    expect(capPayload(null, 1)).toBeNull()
  })
})

function evt(type: Event["type"], text: string, i: number): Event {
  return { id: `e${i}`, type, ts: i, data: { text } }
}

describe("fitEventsToBudget", () => {
  test("passes a history that fits through untouched", () => {
    const events = [evt("user", "hi", 1), evt("assistant", "hello", 2)]
    const fit = fitEventsToBudget(events, 10_000)
    expect(fit.events).toBe(events)
    expect(fit.dropped).toBe(0)
  })

  test("drops the oldest events first and says so", () => {
    const events = Array.from({ length: 40 }, (_, i) => evt(i % 2 ? "assistant" : "user", "m".repeat(200), i))
    const fit = fitEventsToBudget(events, 2_500)

    expect(fit.dropped).toBeGreaterThan(0)
    expect(sizeOf(fit.events)).toBeLessThanOrEqual(2_500)
    // The note comes first, then a contiguous newest slice ending with the last event.
    expect(fit.events[0]?.type).toBe("summary")
    expect((fit.events[0]?.data as { text: string }).text).toContain(`${fit.dropped} earlier events`)
    expect(fit.events[fit.events.length - 1]).toBe(events[39])
    const ids = fit.events.slice(1).map((e) => e.id)
    expect(ids).toEqual(events.slice(40 - ids.length).map((e) => e.id))
  })

  test("keeps a leading summary: it is the archive of what was dropped before", () => {
    const summary = evt("summary", "[ARCHIVED CONTEXT] earlier stuff", 0)
    const events = [summary, ...Array.from({ length: 30 }, (_, i) => evt("assistant", "m".repeat(300), i + 1)), evt("user", "now?", 99)]
    const fit = fitEventsToBudget(events, 2_000)

    expect(fit.events[0]).toBe(summary)
    expect(fit.events[fit.events.length - 1].id).toBe("e99")
    expect(fit.dropped).toBeGreaterThan(0)
  })

  test("keeps the latest user message even when it alone is over budget", () => {
    const events = [evt("assistant", "old", 1), evt("user", "q".repeat(5_000), 2)]
    const fit = fitEventsToBudget(events, 1_000)
    expect(fit.events.map((e) => e.id)).toContain("e2")
    expect(fit.events.map((e) => e.id)).not.toContain("e1")
  })
})
