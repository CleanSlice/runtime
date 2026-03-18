import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "fs"
import { join, relative } from "path"

export interface S3SyncConfig {
  bucket: string
  prefix?: string      // e.g. "bots/botId"
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
}

/**
 * S3SyncService — syncs the entire .agent/ directory to/from S3.
 *
 * S3 layout:  {prefix}/SOUL.md
 *             {prefix}/MEMORY.md
 *             {prefix}/data/memory.sqlite
 *             {prefix}/data/sessions/abc.jsonl
 *             {prefix}/skills/my-skill/SKILL.md
 *             etc.
 */
export class S3SyncService {
  private s3: S3Client
  private bucket: string
  private prefix: string
  private agentDir: string
  private timer?: ReturnType<typeof setInterval>
  private pushing = false

  // Files/dirs to skip — binary blobs that change too often or shouldn't be synced
  private static readonly SKIP_PATTERNS = [
    /\.sqlite-shm$/,
    /\.sqlite-wal$/,
    /node_modules/,
    /\.DS_Store/,
  ]

  constructor(config: S3SyncConfig, agentDir: string) {
    this.bucket = config.bucket
    this.prefix = config.prefix?.replace(/\/$/, "") ?? "agent-data"
    this.agentDir = agentDir

    this.s3 = new S3Client({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
    })

    mkdirSync(agentDir, { recursive: true })
  }

  // ── S3 helpers ────────────────────────────────────────────────────────────────

  private s3Key(relPath: string): string {
    return `${this.prefix}/${relPath}`
  }

  private async s3Get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      const chunks: Uint8Array[] = []
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
      return Buffer.concat(chunks)
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  private async s3Put(key: string, body: Buffer | string): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
    }))
  }

  private async s3List(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const res = await this.s3.send(new ListObjectsV2Command({
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

  private walkDir(dir: string, result: string[] = []): string[] {
    if (!existsSync(dir)) return result
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(this.agentDir, full)
      if (S3SyncService.SKIP_PATTERNS.some(p => p.test(rel))) continue
      if (statSync(full).isDirectory()) {
        this.walkDir(full, result)
      } else {
        result.push(rel)
      }
    }
    return result
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Pull entire .agent/ from S3 on startup.
   * Only downloads files that don't exist locally (init) or exist in S3.
   */
  async pull(): Promise<void> {
    console.log("[s3-sync] pulling from S3...")
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
        count++
      }
    }

    console.log(`[s3-sync] pulled ${count} files`)
  }

  /**
   * Push entire .agent/ to S3.
   * Called periodically + on shutdown.
   */
  async push(): Promise<void> {
    if (this.pushing) {
      console.log("[s3-sync] push already in progress, skipping")
      return
    }
    this.pushing = true
    let count = 0

    try {
      const files = this.walkDir(this.agentDir)
      for (const relPath of files) {
        try {
          const body = readFileSync(join(this.agentDir, relPath))
          await this.s3Put(this.s3Key(relPath), body)
          count++
        } catch (err) {
          console.error(`[s3-sync] failed to push ${relPath}:`, err)
        }
      }
      console.log(`[s3-sync] pushed ${count} files`)
    } finally {
      this.pushing = false
    }
  }

  /**
   * Push a single session file immediately after it's written.
   */
  async pushSession(sessionId: string): Promise<void> {
    const relPath = `data/sessions/${sessionId}.jsonl`
    const localPath = join(this.agentDir, relPath)
    if (!existsSync(localPath)) return
    try {
      await this.s3Put(this.s3Key(relPath), readFileSync(localPath))
    } catch (err) {
      console.error(`[s3-sync] failed to push session ${sessionId}:`, err)
    }
  }

  /**
   * Push access.json immediately after it's written.
   */
  async pushAccess(): Promise<void> {
    const relPath = `data/access.json`
    const localPath = join(this.agentDir, relPath)
    if (!existsSync(localPath)) return
    try {
      await this.s3Put(this.s3Key(relPath), readFileSync(localPath))
    } catch (err) {
      console.error(`[s3-sync] failed to push access:`, err)
    }
  }

  /**
   * Start background periodic sync (push only).
   */
  startAutoSync(intervalSec = 60): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.push().catch(err => console.error("[s3-sync] auto-sync error:", err))
    }, intervalSec * 1000)
    console.log(`[s3-sync] auto-sync started (every ${intervalSec}s)`)
  }

  stopAutoSync(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
