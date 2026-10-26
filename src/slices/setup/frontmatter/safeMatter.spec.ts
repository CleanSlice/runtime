import { describe, expect, test } from "bun:test"
import { safeMatter } from "./safeMatter"

describe("safeMatter", () => {
  test("parses plain YAML frontmatter", () => {
    const out = safeMatter("---\nid: x\nmatch: { tool: 'exec' }\n---\nbody")
    expect(out.data).toEqual({ id: "x", match: { tool: "exec" } })
    expect(out.content.trim()).toBe("body")
  })

  test("refuses executable frontmatter instead of running it", () => {
    let ran = false
    ;(globalThis as Record<string, unknown>).__pwned = () => { ran = true }
    expect(() => safeMatter("---js\n{ id: (globalThis.__pwned(), 'x') }\n---\nbody")).toThrow(/not allowed/)
    expect(() => safeMatter("---javascript\nmodule.exports = { id: 'x' }\n---\nbody")).toThrow(/not allowed/)
    expect(ran).toBe(false)
    delete (globalThis as Record<string, unknown>).__pwned
  })

  test("a file without frontmatter is just content", () => {
    expect(safeMatter("# Title\n\ntext").data).toEqual({})
  })
})
