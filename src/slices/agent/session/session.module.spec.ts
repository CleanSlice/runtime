import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { SessionModule } from "./session.module"
import type { Event } from "../../setup/event"

const archivist = { complete: async () => ({ text: "ARCHIVE" }) }
const MIN = 60_000

async function fill(mod: SessionModule, sessionId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const e: Event = { id: `${sessionId}-${i}`, type: "user", ts: i, data: { text: `m${i} ${"x".repeat(100)}`, from: "u" } }
    await mod.append(sessionId, e)
  }
}

describe("idle compaction sweep (CLEAN-150 US4)", () => {
  test("compacts only sessions idle long enough, over threshold, and not in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idle-"))
    const mod = new SessionModule(dir, { compactionThreshold: 5, recentKeep: 2, compactionBytesThreshold: 1_000_000, idleCompactMin: 30 })
    const now = 1_000_000 * MIN

    const idle = mod.getOrCreate("tg", "idle")
    const busy = mod.getOrCreate("tg", "busy")
    const fresh = mod.getOrCreate("tg", "fresh")
    const small = mod.getOrCreate("tg", "small")
    await fill(mod, idle.id, 8)
    await fill(mod, busy.id, 8)
    await fill(mod, fresh.id, 8)
    await fill(mod, small.id, 2)
    idle.updatedAt = now - 31 * MIN
    busy.updatedAt = now - 31 * MIN
    fresh.updatedAt = now - 5 * MIN
    small.updatedAt = now - 31 * MIN

    const swept = await mod.compactIdle(archivist, now, (id) => id === busy.id)
    expect(swept.sort()).toEqual([idle.id].sort())
    expect((await mod.read(idle.id))[0]!.type).toBe("summary")
    expect((await mod.read(idle.id))[0]!.data).toMatchObject({ reason: "idle" })
    expect((await mod.read(busy.id))[0]!.type).toBe("user")
    expect((await mod.read(fresh.id))[0]!.type).toBe("user")
    expect((await mod.read(small.id)).length).toBe(2)
  })

  test("idleCompactMin 0 disables the sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idle-"))
    const mod = new SessionModule(dir, { compactionThreshold: 5, recentKeep: 2, idleCompactMin: 0 })
    const s = mod.getOrCreate("tg", "a")
    await fill(mod, s.id, 8)
    s.updatedAt = 0
    expect(await mod.compactIdle(archivist, Date.now(), () => false)).toEqual([])
  })
})
