import { describe, expect, test } from "bun:test"
import { parseCron } from "./cron.parser"

describe("parseCron", () => {
  test("all wildcards → all null", () => {
    expect(parseCron("* * * * *")).toEqual({
      minute: null,
      hour: null,
      dom: null,
      month: null,
      dow: null,
    })
  })

  test("daily at 09:00", () => {
    expect(parseCron("0 9 * * *")).toEqual({
      minute: [0],
      hour: [9],
      dom: null,
      month: null,
      dow: null,
    })
  })

  test("specific minute, hour, day-of-month", () => {
    expect(parseCron("30 12 1 * *")).toEqual({
      minute: [30],
      hour: [12],
      dom: [1],
      month: null,
      dow: null,
    })
  })

  test("weekly Mondays at 06:15", () => {
    expect(parseCron("15 6 * * 1")).toEqual({
      minute: [15],
      hour: [6],
      dom: null,
      month: null,
      dow: [1],
    })
  })

  test("collapses multiple whitespace", () => {
    expect(parseCron("0  9   *  *  *")).toEqual(parseCron("0 9 * * *"))
  })

  test("trims leading and trailing whitespace", () => {
    expect(parseCron("  30 12 1 * *  ")).toEqual(parseCron("30 12 1 * *"))
  })

  test("missing trailing fields default to wildcard (null)", () => {
    expect(parseCron("30 9")).toEqual({
      minute: [30],
      hour: [9],
      dom: null,
      month: null,
      dow: null,
    })
  })

  test("month field maps directly (1-12)", () => {
    expect(parseCron("0 0 1 6 *").month).toEqual([6])
  })

  // ── Steps / ranges / lists — the syntax the old parser silently broke on ──

  test("step on wildcard: */15 → every 15 minutes", () => {
    expect(parseCron("*/15 * * * *").minute).toEqual([0, 15, 30, 45])
  })

  test("step on range: 10-20/5", () => {
    expect(parseCron("10-20/5 * * * *").minute).toEqual([10, 15, 20])
  })

  test("vixie N/S: from N to max with step", () => {
    expect(parseCron("* 20/2 * * *").hour).toEqual([20, 22])
  })

  test("plain range 1-5", () => {
    expect(parseCron("* * * * 1-5").dow).toEqual([1, 2, 3, 4, 5])
  })

  test("list 0,30", () => {
    expect(parseCron("0,30 * * * *").minute).toEqual([0, 30])
  })

  test("list of ranges and steps combined", () => {
    expect(parseCron("0-10/5,30,45 * * * *").minute).toEqual([0, 5, 10, 30, 45])
  })

  test("dow 7 normalizes to 0 (Sunday)", () => {
    expect(parseCron("* * * * 7").dow).toEqual([0])
  })

  test("dow range up to 7 includes Sunday once", () => {
    expect(parseCron("* * * * 5-7").dow).toEqual([0, 5, 6])
  })

  // ── Rejection — invalid expressions must THROW, not silently never fire ──

  test("throws on garbage text", () => {
    expect(() => parseCron("abc * * * *")).toThrow(/not a number/)
  })

  test("throws on out-of-range minute", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/within 0-59/)
  })

  test("throws on out-of-range hour", () => {
    expect(() => parseCron("* 24 * * *")).toThrow(/within 0-23/)
  })

  test("throws on inverted range", () => {
    expect(() => parseCron("30-10 * * * *")).toThrow(/inverted/)
  })

  test("throws on zero step", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/positive integer/)
  })

  test("throws on too many fields", () => {
    expect(() => parseCron("* * * * * *")).toThrow(/at most 5 fields/)
  })
})
