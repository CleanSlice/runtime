import { describe, expect, test } from "bun:test"
import { SILENT_REPLY_TOKEN, isSilentReply, isSilentReplyPrefix } from "./silentReply"

describe("isSilentReply", () => {
  test("exact token", () => {
    expect(isSilentReply(SILENT_REPLY_TOKEN)).toBe(true)
  })

  test("tolerates surrounding whitespace", () => {
    expect(isSilentReply(`  ${SILENT_REPLY_TOKEN}\n`)).toBe(true)
  })

  test("token with trailing text is not silent", () => {
    expect(isSilentReply(`${SILENT_REPLY_TOKEN} done.`)).toBe(false)
  })

  test("token with leading text is not silent", () => {
    expect(isSilentReply(`Note: ${SILENT_REPLY_TOKEN}`)).toBe(false)
  })

  test("empty / null / undefined → not silent", () => {
    expect(isSilentReply("")).toBe(false)
    expect(isSilentReply("   ")).toBe(false)
    expect(isSilentReply(null)).toBe(false)
    expect(isSilentReply(undefined)).toBe(false)
  })

  test("natural language starting with 'No' is not silent", () => {
    expect(isSilentReply("No, that won't work.")).toBe(false)
    expect(isSilentReply("Nope")).toBe(false)
  })
})

describe("isSilentReplyPrefix", () => {
  test("each prefix of the token is a prefix", () => {
    for (let i = 1; i <= SILENT_REPLY_TOKEN.length; i++) {
      expect(isSilentReplyPrefix(SILENT_REPLY_TOKEN.slice(0, i))).toBe(true)
    }
  })

  test("tolerates surrounding whitespace", () => {
    expect(isSilentReplyPrefix("  NO_REP\n")).toBe(true)
  })

  test("empty → not a prefix (don't gate the placeholder)", () => {
    expect(isSilentReplyPrefix("")).toBe(false)
    expect(isSilentReplyPrefix("   ")).toBe(false)
    expect(isSilentReplyPrefix(null)).toBe(false)
    expect(isSilentReplyPrefix(undefined)).toBe(false)
  })

  test("diverging text is not a prefix", () => {
    expect(isSilentReplyPrefix("Hi")).toBe(false)
    expect(isSilentReplyPrefix("No, ")).toBe(false)
    expect(isSilentReplyPrefix("NO_REPLY done")).toBe(false)
  })
})
