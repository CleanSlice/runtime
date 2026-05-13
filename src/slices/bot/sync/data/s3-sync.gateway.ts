import type { ISyncGateway } from "../domain/sync.gateway"
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, watch, type FSWatcher } from "fs"
import { join, relative, sep } from "path"

// Lazy-loaded AWS SDK types
type S3Client = import("@aws-sdk/client-s3").S3Client

let _s3Module: typeof import("@aws-sdk/client-s3") | undefined

async function getS3Module() {
  if (!_s3Module) {
    _s3Module = await import("@aws-sdk/client-s3")
  }
  return _s3Module
}

export interface S3SyncConfig {
  bucket: string
  prefix?: string      // e.g. "bots/botId"
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  endpoint?: string    // e.g. "http://host.k3d.internal:9000" for local MinIO
  watcherDebounceMs?: number
}

interface ManifestEntry {
  mtimeMs: number
  size: number
}

/**
 * S3SyncService — syncs the entire .agent/ directory to/from S3.
 *
 * Sync model:
 *  - Pull on startup (full restore)
 *  - Event-driven push: fs.watch enqueues dirty paths, debounced flush
 *    diffs against an in-memory manifest (mtime+size) and pushes only changes
 *  - Optional periodic full sweep as safety net (disabled by default)
 *  - Final diff push on shutdown
 */
export class S3SyncService implements ISyncGateway {
  private s3: S3Client | undefined
  private s3Config: S3SyncConfig
  private bucket: string
  private prefix: string
  private agentDir: string
  private timer?: ReturnType<typeof setInterval>
  private pushing = false

  // Watcher state
  private watcher?: FSWatcher
  private dirty = new Set<string>()
  private flushTimer?: ReturnType<typeof setTimeout>
  private debounceMs: number
  private flushing = false

  // Differential push manifest: relPath -> {mtimeMs, size}
  private manifest = new Map<string, ManifestEntry>()

  // Files/dirs to skip — binary blobs that change too often or shouldn't be synced
  private static readonly SKIP_PATTERNS = [
    /\.sqlite-shm$/,
    /\.sqlite-wal$/,
    /node_modules/,
    /\.DS_Store/,
    /\/\.git\//,       // git internals — repos are re-cloned, not synced
    /\.pack$/,         // git pack files
  ]

  constructor(config: S3SyncConfig, agentDir: string) {
    this.bucket = config.bucket
    this.prefix = config.prefix?.replace(/\/$/, "") ?? "agent-data"
    this.agentDir = agentDir
    this.s3Config = config
    this.debounceMs = config.watcherDebounceMs ?? 30_000

    mkdirSync(agentDir, { recursive: true })
  }

  private async getClient(): Promise<S3Client> {
    if (this.s3) return this.s3
    const { S3Client } = await getS3Module()
    const endpoint = this.s3Config.endpoint ?? process.env.S3_ENDPOINT
    this.s3 = new S3Client({
      region: this.s3Config.region ?? process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: this.s3Config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: this.s3Config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    })
    return this.s3
  }

  // ── S3 helpers ────────────────────────────────────────────────────────────────

  private s3Key(relPath: string): string {
    return `${this.prefix}/${relPath}`
  }

  private async s3Get(key: string): Promise<Buffer | null> {
    try {
      const s3 = await this.getClient()
      const { GetObjectCommand } = await getS3Module()
      const res = await s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      const chunks: Uint8Array[] = []
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
      return Buffer.concat(chunks)
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  private async s3Put(key: string, body: Buffer | string): Promise<void> {
    const s3 = await this.getClient()
    const { PutObjectCommand } = await getS3Module()
    await s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
    }))
  }

  private async s3List(prefix: string): Promise<string[]> {
    const s3 = await this.getClient()
    const { ListObjectsV2Command } = await getS3Module()
    const keys: string[] = []
    let token: string | undefined
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }))
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key)
      }
      token = res.NextContinuationToken
    } while (token)
    return keys
  }

  // ── Local file walker ─────────────────────────────────────────────────────────

  private isSkipped(rel: string): boolean {
    const norm = rel.split(sep).join("/")
    return S3SyncService.SKIP_PATTERNS.some((p) => p.test(norm))
  }

  private walkDir(dir: string, result: string[] = []): string[] {
    if (!existsSync(dir)) return result
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(this.agentDir, full)
      if (this.isSkipped(rel)) continue
      if (statSync(full).isDirectory()) {
        this.walkDir(full, result)
      } else {
        result.push(rel)
      }
    }
    return result
  }

  // ── Differential push core ────────────────────────────────────────────────────

  /** Push a single file if mtime/size differs from manifest. Returns true if pushed. */
  private async pushIfChanged(relPath: string): Promise<boolean> {
    const localPath = join(this.agentDir, relPath)
    if (!existsSync(localPath)) {
      // File deleted locally — drop from manifest. (We don't delete from S3 yet.)
      this.manifest.delete(relPath)
      return false
    }
    const stat = statSync(localPath)
    if (!stat.isFile()) return false
    const prev = this.manifest.get(relPath)
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      return false
    }
    const body = readFileSync(localPath)
    await this.s3Put(this.s3Key(relPath), body)
    this.manifest.set(relPath, { mtimeMs: stat.mtimeMs, size: stat.size })
    return true
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Pull entire .agent/ from S3 on startup. Populates the manifest only with
   * files that actually exist in S3 — local-only files (e.g. freshly scaffolded
   * from .agent.example on first run) are intentionally left out so the next
   * push() sweep uploads them.
   */
  async pull(): Promise<void> {
    let count = 0
    const keys = await this.s3List(`${this.prefix}/`)

    for (const key of keys) {
      const relPath = key.slice(`${this.prefix}/`.length)
      if (!relPath) continue
      const localPath = join(this.agentDir, relPath)
      const dir = localPath.substring(0, localPath.lastIndexOf("/"))
      mkdirSync(dir, { recursive: true })
      const body = await this.s3Get(key)
      if (body) {
        writeFileSync(localPath, body)
        const stat = statSync(localPath)
        this.manifest.set(relPath, { mtimeMs: stat.mtimeMs, size: stat.size })
        count++
      }
    }

    console.log(`[s3] pulled ${count} files`)
  }

  /**
   * Full sweep: walk the directory and push files whose mtime/size changed
   * since the last successful push. Used as periodic safety net and on shutdown.
   * Returns the number of files actually pushed in this sweep.
   */
  async push(): Promise<number> {
    if (this.pushing) {
      console.log("[s3] push already in progress, skipping")
      return 0
    }
    this.pushing = true
    let pushed = 0

    try {
      const files = this.walkDir(this.agentDir)
      for (const relPath of files) {
        try {
          if (await this.pushIfChanged(relPath)) pushed++
        } catch (err) {
          console.error(`[s3] failed to push ${relPath}:`, err)
        }
      }
      if (pushed > 0) console.log(`[s3] sweep pushed ${pushed} changed files`)
    } finally {
      this.pushing = false
    }
    return pushed
  }

  /** Start fs.watch-based event-driven sync. */
  startWatcher(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.agentDir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const rel = filename.toString()
        if (this.isSkipped(rel)) return
        this.dirty.add(rel)
        this.scheduleFlush()
      })
      console.log(`[s3] watcher started, debounce ${this.debounceMs}ms`)
    } catch (err) {
      console.error("[s3] failed to start watcher:", err)
    }
  }

  stopWatcher(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = undefined
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushDirty().catch(err => console.error("[s3] flush error:", err))
    }, this.debounceMs)
  }

  private async flushDirty(): Promise<void> {
    if (this.flushing || this.dirty.size === 0) return
    this.flushing = true
    const batch = Array.from(this.dirty)
    this.dirty.clear()

    let pushed = 0
    try {
      for (const relPath of batch) {
        try {
          if (await this.pushIfChanged(relPath)) pushed++
        } catch (err) {
          console.error(`[s3] failed to push ${relPath}:`, err)
          this.dirty.add(relPath) // retry next flush
        }
      }
      if (pushed > 0) console.log(`[s3] flushed ${pushed} changed files`)
    } finally {
      this.flushing = false
      // If new dirty paths arrived during the flush, schedule another round.
      if (this.dirty.size > 0) this.scheduleFlush()
    }
  }

  /**
   * Optional periodic full sweep as safety net. Pass intervalSec <= 0 to disable.
   * The sweep is differential — unchanged files are skipped.
   */
  startAutoSync(intervalSec = 0): void {
    if (this.timer) return
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) return
    this.timer = setInterval(() => {
      this.push().catch(err => console.error("[s3] auto-sync error:", err))
    }, intervalSec * 1000)
    console.log(`[s3] periodic full sweep every ${intervalSec}s (safety net)`)
  }

  stopAutoSync(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
