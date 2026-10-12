import { describe, expect, test } from "bun:test"
import { matchesTool, argMatches, resultMatches, resolveRelativePaths } from "./rule.matcher"

describe("matchesTool", () => {
  test("exact name, alternatives and globs", () => {
    expect(matchesTool("exec", "exec")).toBe(true)
    expect(matchesTool("exec", "exec2")).toBe(false)
    expect(matchesTool("exec|file|unzip", "file")).toBe(true)
    expect(matchesTool("exec|file", "http")).toBe(false)
    expect(matchesTool("mcp__*", "mcp__ranch__list")).toBe(true)
    expect(matchesTool("ranch__*", "ranch__list")).toBe(true)
    expect(matchesTool("*", "anything")).toBe(true)
  })

  test("glob metacharacters other than * are literal", () => {
    expect(matchesTool("a.b", "axb")).toBe(false)
    expect(matchesTool("a.b", "a.b")).toBe(true)
  })
})

describe("argMatches", () => {
  const agentDir = "/agent"

  test("$ tests the whole serialized params", () => {
    expect(argMatches({ path: "$", pattern: "data/secrets" }, { command: "cat data/secrets/x" }, agentDir)).toBe(true)
    expect(argMatches({ path: "$", pattern: "data/secrets" }, { command: "ls data/public" }, agentDir)).toBe(false)
  })

  test("$.field tests one property; a missing property never matches", () => {
    expect(argMatches({ path: "$.method", pattern: "^DELETE$" }, { url: "x", method: "DELETE" }, agentDir)).toBe(true)
    expect(argMatches({ path: "$.method", pattern: "^DELETE$" }, { url: "x", method: "GET" }, agentDir)).toBe(false)
    expect(argMatches({ path: "$.method", pattern: "^DELETE$" }, { url: "x" }, agentDir)).toBe(false)
    expect(argMatches({ path: "$.a.b", pattern: "deep" }, { a: { b: "deep value" } }, agentDir)).toBe(true)
  })

  test("relative paths in params resolve against the agent dir", () => {
    expect(argMatches({ path: "$", pattern: "^.*/agent/data/secrets" }, { command: "cat ./data/secrets/key" }, agentDir)).toBe(true)
    expect(argMatches({ path: "$.path", pattern: "/agent/data/secrets" }, { action: "read", path: "data/secrets/key" }, agentDir)).toBe(true)
    expect(argMatches({ path: "$.path", pattern: "/agent/data/secrets" }, { action: "read", path: "/etc/hosts" }, agentDir)).toBe(false)
  })

  test("non-object params are matched as strings", () => {
    expect(argMatches({ path: "$", pattern: "secret" }, "top secret", agentDir)).toBe(true)
    expect(argMatches({ path: "$.x", pattern: "secret" }, "top secret", agentDir)).toBe(false)
  })

  test("an invalid regex throws so the loader can refuse the rule", () => {
    expect(() => argMatches({ path: "$", pattern: "(" }, {}, agentDir)).toThrow()
  })
})

describe("resultMatches", () => {
  test("tests the serialized result", () => {
    expect(resultMatches("sk-ant-", { content: "token sk-ant-oat01-abc" })).toBe(true)
    expect(resultMatches("sk-ant-", { content: "nothing" })).toBe(false)
    expect(resultMatches("plain", "plain string")).toBe(true)
  })
})

describe("resolveRelativePaths", () => {
  test("rewrites relative path tokens and leaves absolute ones and URLs alone", () => {
    expect(resolveRelativePaths("cat data/secrets/x", "/agent")).toBe("cat /agent/data/secrets/x")
    expect(resolveRelativePaths("cat ./a/b ../c/d", "/agent")).toBe("cat /agent/a/b /c/d")
    expect(resolveRelativePaths("cat /etc/hosts", "/agent")).toBe("cat /etc/hosts")
    expect(resolveRelativePaths("curl https://x.test/a/b", "/agent")).toBe("curl https://x.test/a/b")
    expect(resolveRelativePaths("echo hi", "/agent")).toBe("echo hi")
  })
})
