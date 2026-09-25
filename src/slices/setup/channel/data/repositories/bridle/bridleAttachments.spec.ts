import { describe, expect, test } from "bun:test"
import { readOrigin, sanitizeWireAttachments } from "./bridle.repository"
import { buildMessage } from "../../../domain/channel.types"

const valid = {
  id: "att-1",
  name: "photo.png",
  mimeType: "image/png",
  size: 1234,
  kind: "image",
}

describe("sanitizeWireAttachments", () => {
  test("keeps well-formed entries", () => {
    expect(sanitizeWireAttachments([valid])).toEqual([valid])
  })

  test("drops entries missing required string fields", () => {
    expect(sanitizeWireAttachments([{ ...valid, id: undefined }])).toEqual([])
    expect(sanitizeWireAttachments([{ ...valid, name: 42 }])).toEqual([])
    expect(sanitizeWireAttachments([{ ...valid, mimeType: null }])).toEqual([])
  })

  test("drops entries with an unknown kind", () => {
    expect(sanitizeWireAttachments([{ ...valid, kind: "video" }])).toEqual([])
  })

  test("coerces a missing size to 0 rather than dropping the entry", () => {
    const noSize = { ...valid } as Record<string, unknown>
    delete noSize.size
    expect(sanitizeWireAttachments([noSize])).toEqual([{ ...valid, size: 0 }])
  })

  test("strips unknown extra fields so only metadata is persisted", () => {
    expect(
      sanitizeWireAttachments([{ ...valid, base64: "AAAA", url: "/x" }]),
    ).toEqual([valid])
  })

  test("returns [] for non-array input", () => {
    expect(sanitizeWireAttachments(undefined)).toEqual([])
    expect(sanitizeWireAttachments("nope")).toEqual([])
    expect(sanitizeWireAttachments({})).toEqual([])
  })

  test("keeps good entries when a sibling is malformed", () => {
    expect(sanitizeWireAttachments([{ junk: true }, valid])).toEqual([valid])
  })
})

describe("buildMessage attachments passthrough", () => {
  test("carries attachments onto the Message", () => {
    const msg = buildMessage({
      id: "m1",
      text: "look",
      from: "admin",
      channel: "bridle",
      ts: 1,
      attachments: [valid],
    })
    expect(msg.attachments).toEqual([valid])
  })

  test("omits the field entirely when there are none", () => {
    const msg = buildMessage({
      id: "m1",
      text: "look",
      from: "admin",
      channel: "bridle",
      ts: 1,
    })
    expect("attachments" in msg).toBe(false)
  })
})

/**
 * The origin the hub forwards (CLEAN-120) is kept only as an http(s) origin
 * proper; whatever else arrives is dropped rather than turned into a link.
 */
describe("readOrigin", () => {
  test("keeps an http(s) origin and strips anything after it", () => {
    expect(readOrigin("https://admin.ranch.test")).toBe("https://admin.ranch.test")
    expect(readOrigin("http://localhost:3002/some/path?x=1")).toBe("http://localhost:3002")
  })

  test("drops other schemes, garbage and non-strings", () => {
    expect(readOrigin("javascript:alert(1)")).toBeUndefined()
    expect(readOrigin("not a url")).toBeUndefined()
    expect(readOrigin(undefined)).toBeUndefined()
    expect(readOrigin({ origin: "https://x" })).toBeUndefined()
  })

  test("rides on the built message only when present", () => {
    const base = { id: "m1", text: "hi", from: "admin", channel: "bridle", ts: 1 }
    expect(buildMessage({ ...base, origin: "https://admin.ranch.test" }).origin).toBe("https://admin.ranch.test")
    expect("origin" in buildMessage(base)).toBe(false)
  })
})
