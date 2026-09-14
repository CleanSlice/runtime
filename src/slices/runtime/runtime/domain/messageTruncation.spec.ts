import { describe, expect, test } from "bun:test"
import { limitForUserEvent, truncateUserText, type IMessageLimits } from "./messageTruncation"

const LIMITS: IMessageLimits = { maxChars: 4000, maxCharsWithAttachments: 48_000 }

describe("truncateUserText", () => {
  test("short text is returned untouched", () => {
    expect(truncateUserText("hello", 4000)).toBe("hello")
  })

  test("text exactly at the limit is untouched", () => {
    const text = "x".repeat(4000)
    expect(truncateUserText(text, 4000)).toBe(text)
  })

  test("keeps head + tail and marks the gap", () => {
    const text = "H".repeat(3000) + "T".repeat(3000)
    const out = truncateUserText(text, 4000)

    expect(out.startsWith("H".repeat(2000))).toBe(true)
    expect(out.endsWith("T".repeat(500))).toBe(true)
    expect(out).toContain("characters truncated")
  })

  test("reports the number of characters actually removed", () => {
    // 6000 chars, limit 4000 → keeps head 2000 + tail 500, so 3500 go.
    // The old notice computed len - limit + 500 = 2500 and understated by 1000.
    const text = "x".repeat(6000)
    const out = truncateUserText(text, 4000)

    expect(out).toContain("3500 characters truncated")
    expect(out).not.toContain("2500 characters truncated")
  })

  test("the notice count matches what is missing from the output", () => {
    const text = "y".repeat(10_000)
    const out = truncateUserText(text, 4000)

    const reported = Number(/\[… (\d+) characters truncated/.exec(out)?.[1])
    const kept = out.replace(/\n\n\[….*?…\]\n\n/s, "").length
    expect(reported).toBe(text.length - kept)
  })

  test("a limit larger than the text leaves it alone", () => {
    const text = "z".repeat(30_000)
    expect(truncateUserText(text, 48_000)).toBe(text)
  })

  test("a tiny limit still produces a shorter string than the input", () => {
    const text = "q".repeat(1000)
    const out = truncateUserText(text, 100)
    expect(out.length).toBeLessThan(text.length)
    expect(out).toContain("characters truncated")
  })

  test("non-positive limit disables truncation", () => {
    const text = "w".repeat(9000)
    expect(truncateUserText(text, 0)).toBe(text)
  })
})

describe("limitForUserEvent", () => {
  test("plain message gets the ordinary cap", () => {
    expect(limitForUserEvent(false, LIMITS)).toBe(4000)
  })

  test("message carrying an attachment gets the larger cap", () => {
    expect(limitForUserEvent(true, LIMITS)).toBe(48_000)
  })

  test("the attachment cap clears the API's 40 000-char preview budget", () => {
    // api/src/slices/bridle/domain/attachment.constants.ts
    //   SPREADSHEET_INLINE_BUDGET_CHARS = 40_000
    const preview = "p".repeat(40_000)
    const limit = limitForUserEvent(true, LIMITS)
    expect(truncateUserText(preview, limit)).toBe(preview)
  })
})
