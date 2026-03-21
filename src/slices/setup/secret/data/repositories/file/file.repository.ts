import type { ISecretGateway, SecretStore } from "../../../domain/secret.types"
import { mkdirSync, existsSync } from "fs"
import { readFile, writeFile } from "fs/promises"
import { join } from "path"

/**
 * File-based secret store. Each user gets their own JSON file.
 * Path: <agentDir>/data/secrets/<userId>.json
 * 
 * ⚠️ Dev only — values stored in plaintext. Use AWS for production.
 */
export class FileSecretRepository implements ISecretGateway {
  private dir: string

  constructor(agentDir: string) {
    this.dir = join(agentDir, "data", "secrets")
    mkdirSync(this.dir, { recursive: true })
  }

  private path(userId: string): string {
    // Sanitize userId to prevent path traversal
    const safe = userId.replace(/[^a-zA-Z0-9_\-:.]/g, "_")
    return join(this.dir, `${safe}.json`)
  }

  private async load(userId: string): Promise<SecretStore> {
    const path = this.path(userId)
    if (!existsSync(path)) return {}
    try {
      const text = await readFile(path, "utf-8")
      return JSON.parse(text) as SecretStore
    } catch {
      return {}
    }
  }

  private async save(userId: string, store: SecretStore): Promise<void> {
    await writeFile(this.path(userId), JSON.stringify(store, null, 2), "utf-8")
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    const store = await this.load(userId)
    return store[key]
  }

  async set(userId: string, key: string, value: string): Promise<void> {
    const store = await this.load(userId)
    store[key] = value
    await this.save(userId, store)
  }

  async delete(userId: string, key: string): Promise<void> {
    const store = await this.load(userId)
    delete store[key]
    await this.save(userId, store)
  }

  async list(userId: string): Promise<string[]> {
    const store = await this.load(userId)
    return Object.keys(store)
  }
}
