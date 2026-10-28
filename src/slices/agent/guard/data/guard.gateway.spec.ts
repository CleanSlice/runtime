import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GuardGateway } from "./guard.gateway"
import { parseRule } from "../domain/guard.service"

const RULE = `---
id: no-prod-deletes
event: before
match:
  tool: 'http'
action: block
---
Deleting through the API is done from the console.
`

describe("GuardGateway.loadRuleFiles", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-"))
    mkdirSync(join(dir, "rules"))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("skips the folder's README so documentation is not parsed as a rule", () => {
    // The scaffold ships .agent.example/rules/README.md; read as a rule it has
    // no id, fails the load, and every tool call is blocked.
    writeFileSync(join(dir, "rules", "README.md"), readFileSync(join(import.meta.dir, "../../../../../.agent.example/rules/README.md")))
    writeFileSync(join(dir, "rules", "readme.md"), "# notes\n")
    writeFileSync(join(dir, "rules", "no-prod-deletes.md"), RULE)

    const gw = new GuardGateway(dir, { recordFile: "data/toolcalls.jsonl", recordMaxBytes: 1_000_000, baselineDir: join(dir, "none") })
    const files = gw.loadRuleFiles()

    expect(files.map(f => f.file)).toEqual(["rules/no-prod-deletes.md"])
    expect(() => files.map(parseRule)).not.toThrow()
  })
})
