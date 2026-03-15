import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs"
import { readFile, writeFile } from "fs/promises"

export interface S3SyncConfig {
  bucket: string
  prefix?: string      // e.g. "cleanslice/agent-data"
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
}

/**
 * S3SyncService — syncs .agent/data to/from S3.
 *
 * Usage:
 *   const sync = new S3SyncService(config, agentDir)
 *   await sync.pull()         // on startup: download everything from S3
 *   await sync.push()         // on demand: upload everything to S3
 *   sync.startAutoSync(60)    // background sync every N seconds
 */
export class S3SyncService {
  private s3: S3Client
  private bucket: string
  private prefix: string
  private dataDir: string
  private sessionsDir: string
  private timer?: ReturnType<typeof setInterval>

  constructor(config: S3SyncConfig, agentDir: string) {
    this.bucket = config.bucket
    this.prefix = config.prefix?.replace(/\/$/, "") ?? "agent-data"
    this.dataDir = `${agentDir}/data`
    this.sessionsDir = `${agentDir}/data/sessions`

    this.s3 = new S3Client({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
    })

    mkdirSync(this.sessionsDir, { recursive: true })
  }

  private s3Key(localPath: string): string {
    // localPath relative to dataDir → s3 key
    return `${this.prefix}/${localPath}`
  }

  private async s3Get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      const chunks: Uint8Array[] = []
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
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

  /**
   * Pull all data from S3 → local on startup.
   */
  async pull(): Promise<void> {
    console.log("[s3-sync] pulling from S3...")
    let count = 0

    // List all files under our prefix
    const keys = await this.s3List(`${this.prefix}/`)

    for (const key of keys) {
      const localRelPath = key.slice(`${this.prefix}/`.length)   // e.g. "access.json" or "sessions/abc.jsonl"
      const localPath = `${this.dataDir}/${localRelPath}`

      // Ensure parent dir exists
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
   * Push all local data → S3.
   * Called periodically + on shutdown.
   */
  async push(): Promise<void> {
    let count = 0

    // access.json
    await this.pushFile("access.json")
    count++

    // memory.sqlite
    await this.pushFile("memory.sqlite")
    count++

    // secrets/ directory
    const secretsDir = `${this.dataDir}/secrets`
    if (existsSync(secretsDir)) {
      for (const file of readdirSync(secretsDir)) {
        await this.pushFile(`secrets/${file}`)
        count++
      }
    }

    // sessions/*.jsonl
    if (existsSync(this.sessionsDir)) {
      for (const file of readdirSync(this.sessionsDir)) {
        if (file.endsWith(".jsonl")) {
          await this.pushFile(`sessions/${file}`)
          count++
        }
      }
    }

    console.log(`[s3-sync] pushed ${count} files`)
  }

  private async pushFile(relPath: string): Promise<void> {
    const localPath = `${this.dataDir}/${relPath}`
    if (!existsSync(localPath)) return
    try {
      const body = await readFile(localPath)
      await this.s3Put(this.s3Key(relPath), body)
    } catch (err) {
      console.error(`[s3-sync] failed to push ${relPath}:`, err)
    }
  }

  /**
   * Push a single session file immediately after it's written.
   * Call this from SessionGateway after append/rewrite.
   */
  async pushSession(sessionId: string): Promise<void> {
    await this.pushFile(`sessions/${sessionId}.jsonl`)
  }

  /**
   * Push access.json immediately after it's written.
   */
  async pushAccess(): Promise<void> {
    await this.pushFile("access.json")
  }

  /**
   * Start background periodic sync (push only).
   * @param intervalSec — seconds between syncs (default 60)
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
