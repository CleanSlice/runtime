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
      minute: 0,
      hour: 9,
      dom: null,
      month: null,
      dow: null,
    })
  })

  test("specific minute, hour, day-of-month", () => {
    expect(parseCron("30 12 1 * *")).toEqual({
      minute: 30,
      hour: 12,
      dom: 1,
      month: null,
      dow: null,
    })
  })

  test("weekly Mondays at 06:15", () => {
    expect(parseCron("15 6 * * 1")).toEqual({
      minute: 15,
      hour: 6,
      dom: null,
      month: null,
      dow: 1,
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
      minute: 30,
      hour: 9,
      dom: null,
      month: null,
      dow: null,
    })
  })

  test("month field maps directly (1-12)", () => {
    expect(parseCron("0 0 1 6 *").month).toBe(6)
  })
})
