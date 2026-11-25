import { describe, expect, test } from "bun:test"
import { buildToolServersPrompt } from "./prompts/toolServers.prompt"

/** What the model hears about a missing tool server (CLEAN-245, R14). */
describe("buildToolServersPrompt", () => {
  test("nothing missing: no section, the prompt stays as it was", () => {
    expect(buildToolServersPrompt([])).toBeUndefined()
    expect(buildToolServersPrompt([{ name: "Ranch", state: "connected" }])).toBeUndefined()
  })

  test("a server still being tried", () => {
    expect(
      buildToolServersPrompt([
        { name: "Ranch", state: "connected" },
        { name: "Documents", state: "retrying" },
      ]),
    ).toBe(
      "Some of your tools are not available right now: Documents (still trying to reconnect). " +
        "Do not answer from memory what those tools would have told you. " +
        "Say plainly that this part is unavailable. " +
        "Tell the person to try again shortly only for the ones marked as still reconnecting.",
    )
  })

  test("a refused server needs an administrator, and nobody is told to wait", () => {
    const text = buildToolServersPrompt([{ name: "Jira", state: "refused" }])!
    expect(text).toContain("Jira (not reconnecting — needs an administrator)")
    expect(text).toContain("Do not tell the person to try again later")
    expect(text).not.toContain("try again shortly")
  })

  test("both kinds are named apart", () => {
    const text = buildToolServersPrompt([
      { name: "Documents", state: "retrying" },
      { name: "Jira", state: "refused" },
    ])!
    expect(text).toContain("Documents (still trying to reconnect), Jira (not reconnecting — needs an administrator)")
    expect(text).toContain("only for the ones marked as still reconnecting")
  })
})
