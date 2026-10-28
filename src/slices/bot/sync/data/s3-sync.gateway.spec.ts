import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { S3SyncService } from "./s3-sync.gateway"

// In-memory bucket standing in for S3: the private S3 helpers are swapped out
// so the pull/hydrate/discard logic runs against real files on disk.
function makeService(dir: string, objects: Record<string, string>, opts: { gate?: Promise<void> } = {}) {
  const svc = new S3SyncService({ bucket: "b", prefix: "bots/x", watcherDebounceMs: 10 }, dir)
  const store = new Map(Object.entries(objects).map(([k, v]) => [`bots/x/${k}`, v]))
  const gets: string[] = []
  const deletes: string[] = []
  const s = svc as any
  s.s3List = async () => Array.from(store.keys())
  s.s3Get = async (key: string) => {
    gets.push(key)
    if (opts.gate && key.includes("data/sessions/")) await opts.gate
    const v = store.get(key)
    return v === undefined ? null : Buffer.from(v)
  }
  s.s3Delete = async (key: string) => { deletes.push(key); store.delete(key) }
  s.s3Put = async (key: string, body: Buffer) => { store.set(key, body.toString()) }
  return { svc, gets, deletes, store }
}

describe("S3SyncService deferred pull", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "s3sync-")) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("pull() restores config but leaves transcripts for the background", async () => {
    const { svc } = makeService(dir, {
      "SOUL.md": "soul",
      "data/sessions/telegram:1.jsonl": "{}\n",
    })
    await svc.pull()
    expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe("soul")
    expect(existsSync(join(dir, "data/sessions/telegram:1.jsonl"))).toBe(false)

    await svc.startBackgroundPull()
    expect(readFileSync(join(dir, "data/sessions/telegram:1.jsonl"), "utf8")).toBe("{}\n")
  })

  test("hydrate() fetches a transcript ahead of the queue, once", async () => {
    const { svc, gets } = makeService(dir, { "data/sessions/a.jsonl": "old\n" })
    await svc.pull()
    await Promise.all([svc.hydrate("data/sessions/a.jsonl"), svc.hydrate("data/sessions/a.jsonl")])
    expect(readFileSync(join(dir, "data/sessions/a.jsonl"), "utf8")).toBe("old\n")

    await svc.startBackgroundPull()
    expect(gets.filter(k => k.endsWith("a.jsonl"))).toHaveLength(1)
  })

  test("discard() during an in-flight download does not resurrect the file, and deletes it remotely", async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { svc, store } = makeService(dir, { "data/sessions/a.jsonl": "old\n" }, { gate })
    await svc.pull()
    const job = svc.hydrate("data/sessions/a.jsonl")
    svc.discard("data/sessions/a.jsonl")
    release()
    await job
    expect(existsSync(join(dir, "data/sessions/a.jsonl"))).toBe(false)

    await new Promise(r => setTimeout(r, 50)) // debounced flush propagates the delete
    expect(store.has("bots/x/data/sessions/a.jsonl")).toBe(false)
  })
})
