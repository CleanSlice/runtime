import { describe, expect, test } from "bun:test"
import { ToolGateway } from "./tool.gateway"
import { effectOfCall } from "../domain/tool.types"

describe("built-in tool effects (CLEAN-150)", () => {
  const tools = new ToolGateway().getAll()

  test("every registered tool declares effect or effectOf", () => {
    const missing = tools.filter(t => !t.effect && !t.effectOf).map(t => t.name)
    expect(missing).toEqual([])
  })

  test("file decides per call: read stays read, write is write", () => {
    const file = tools.find(t => t.name === "file")!
    expect(effectOfCall(file, { action: "read", path: "x" })).toBe("read")
    expect(effectOfCall(file, { action: "write", path: "x", content: "" })).toBe("write")
  })

  test("http decides per method and defaults to GET", () => {
    const http = tools.find(t => t.name === "http")!
    expect(effectOfCall(http, { url: "https://a.test/" })).toBe("read")
    expect(effectOfCall(http, { url: "https://a.test/", method: "delete" })).toBe("write")
  })

  test("an unannotated tool counts as write", () => {
    expect(effectOfCall({ name: "x", description: "", schema: undefined as never, execute: async () => null }, {})).toBe("write")
  })

  test("malformed params fall back to write rather than throwing", () => {
    const file = tools.find(t => t.name === "file")!
    expect(effectOfCall(file, "not an object")).toBe("write")
  })
})
