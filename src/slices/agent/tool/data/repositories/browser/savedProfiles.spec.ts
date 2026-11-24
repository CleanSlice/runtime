import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { savedProfiles } from "./browserLogin.repository"
import type { ToolContext } from "../../../domain/tool.types"

// CLEAN-243: session_list told a person "there is no profile shadow" right
// after they shared it, because it only knew the integration list.
function agentWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "saved-profiles-"))
  mkdirSync(join(dir, "browser-state"))
  for (const f of files) writeFileSync(join(dir, "browser-state", f), "{}")
  return dir
}

const ctx = (agentDir: string, from?: string) => ({ agentDir, from }) as unknown as ToolContext

describe("savedProfiles", () => {
  const dir = agentWith([
    "admin-shadow.json",
    "admin-instagram:main.json",
    "user-8c10-github.json",
    "admin-.json",
    "notes.txt",
  ])

  test("lists the person's own profiles only", () => {
    expect(savedProfiles(ctx(dir, "admin"))).toEqual(["instagram:main", "shadow"])
    expect(savedProfiles(ctx(dir, "user-8c10"))).toEqual(["github"])
  })

  test("a turn with no person, or an agent with no folder, has none", () => {
    expect(savedProfiles(ctx(dir, "cron"))).toEqual([])
    expect(savedProfiles(ctx(dir))).toEqual([])
    expect(savedProfiles(ctx(join(dir, "nowhere"), "admin"))).toEqual([])
  })
})
