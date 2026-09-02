import { describe, expect, test } from "bun:test"
import { sanitizeWireAttachments } from "./bridle.repository"
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
