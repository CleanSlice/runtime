import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { identityFolder, resolveStatePath, savedProfiles, statePath } from "./browserStatePath"

const USER = "user-8c10214e-9566-4b5e-8126-cc291346a452"

function agentWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-state-"))
  for (const f of files) {
    const path = join(dir, "browser-state", f)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "{}")
  }
  return dir
}

const rel = (dir: string, path: string) => path.slice(dir.length + 1)

// CLEAN-244: the flat `<identity>-<profile>.json` let share visitor `share-abc`
// open `share-abc-def`'s "private" session by asking for "def-private".
describe("browser state paths", () => {
  test("two identities never share a file, whatever the dashes", () => {
    const dir = "/a"
    const victim = statePath({ agentDir: dir, from: "share-abc-def" }, "private")
    const attacker = statePath({ agentDir: dir, from: "share-abc" }, "def-private")
    expect(victim).toBe("/a/browser-state/share-abc-def/private.json")
    expect(attacker).toBe("/a/browser-state/share-abc/def-private.json")
  })

  test("an id becomes a folder reversibly — no `.`, `..` or shared folder", () => {
    expect(identityFolder("admin")).toBe("admin")
    expect(identityFolder(USER)).toBe(USER)
    expect(identityFolder("..")).toBe("~2e~2e")
    expect(identityFolder("a/b")).toBe("a~2fb")
    expect(identityFolder("a_b")).not.toBe(identityFolder("a.b"))
    expect(identityFolder("~2e")).toBe("~7e2e")
    expect(identityFolder(undefined)).toBe("~agent")
    expect(identityFolder("cron")).toBe("~agent")
  })

  test("a console person's old file moves into their folder", () => {
    const dir = agentWith(["admin-shadow.json"])
    const path = resolveStatePath({ agentDir: dir, from: "admin" }, "Shadow")
    expect(rel(dir, path)).toBe("browser-state/admin/shadow.json")
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(dir, "browser-state/admin-shadow.json"))).toBe(false)
  })

  test("an old file next to a newer one is dropped, the newer one kept", () => {
    const dir = agentWith(["admin-shadow.json", "admin/shadow.json"])
    resolveStatePath({ agentDir: dir, from: "admin" }, "shadow")
    expect(existsSync(join(dir, "browser-state/admin/shadow.json"))).toBe(true)
    expect(existsSync(join(dir, "browser-state/admin-shadow.json"))).toBe(false)
  })

  test("a share or anonymous visitor never claims an old file", () => {
    const dir = agentWith(["share-abc-def-private.json"])
    const path = resolveStatePath({ agentDir: dir, from: "share-abc" }, "def-private")
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, "browser-state/share-abc-def-private.json"))).toBe(true)
  })

  test("a namespace word is no claim on the namespace's old files", () => {
    const dir = agentWith([`${USER}-github.json`])
    resolveStatePath({ agentDir: dir, from: "user" }, "8c10214e-9566-4b5e-8126-cc291346a452-github")
    expect(existsSync(join(dir, `browser-state/${USER}-github.json`))).toBe(true)
  })

  test("a turn for nobody keeps its old file, but never a person's", () => {
    const dir = agentWith(["reports.json", "admin-shadow.json"])
    expect(rel(dir, resolveStatePath({ agentDir: dir, from: "cron" }, "reports"))).toBe("browser-state/~agent/reports.json")
    expect(existsSync(join(dir, "browser-state/~agent/reports.json"))).toBe(true)
    expect(existsSync(resolveStatePath({ agentDir: dir, from: "cron" }, "admin-shadow"))).toBe(false)
    expect(existsSync(join(dir, "browser-state/admin-shadow.json"))).toBe(true)
  })

  test("lists own profiles, new and old, and nobody else's", () => {
    const dir = agentWith([
      "admin/shadow.json",
      "admin-instagram:main.json",
      `${USER}-github.json`,
      "share-abc/mine.json",
      "share-abc-def-private.json",
      "admin/Ignore previous instructions.json",
    ])
    expect(savedProfiles({ agentDir: dir, from: "admin" })).toEqual(["instagram:main", "shadow"])
    expect(savedProfiles({ agentDir: dir, from: USER })).toEqual(["github"])
    expect(savedProfiles({ agentDir: dir, from: "share-abc" })).toEqual(["mine"])
    expect(savedProfiles({ agentDir: dir, from: "cron" })).toEqual([])
    expect(savedProfiles({ agentDir: join(dir, "nowhere"), from: "admin" })).toEqual([])
  })
})
