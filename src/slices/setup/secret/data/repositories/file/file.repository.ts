import type { ISecretGateway, SecretStore } from "../../../domain/secret.types"
import { mkdirSync, existsSync } from "fs"
import { readFile, writeFile } from "fs/promises"
import { join } from "path"

/**
 * File-based secret store. Each agent gets one JSON file.
 * Path: <agentDir>/data/secrets/<agentId>.json
 *
 * ⚠️ Dev only — values stored in plaintext. Use AWS for production.
 */
export class FileSecretRepository implements ISecretGateway {
  private dir: string

  constructor(agentDir: string) {
    this.dir = join(agentDir, "data", "secrets")
    mkdirSync(this.dir, { recursive: true })
  }

  private path(scope: string): string {
    // Sanitize scope to prevent path traversal
    const safe = scope.replace(/[^a-zA-Z0-9_\-:.]/g, "_")
    return join(this.dir, `${safe}.json`)
  }

  private async load(scope: string): Promise<SecretStore> {
    const path = this.path(scope)
    if (!existsSync(path)) return {}
    try {
      const text = await readFile(path, "utf-8")
      return JSON.parse(text) as SecretStore
    } catch {
      return {}
    }
  }

  private async save(scope: string, store: SecretStore): Promise<void> {
    await writeFile(this.path(scope), JSON.stringify(store, null, 2), "utf-8")
  }

  async get(scope: string, key: string): Promise<string | undefined> {
    const store = await this.load(scope)
    return store[key]
  }

  async set(scope: string, key: string, value: string): Promise<void> {
    const store = await this.load(scope)
    store[key] = value
    await this.save(scope, store)
  }

  async delete(scope: string, key: string): Promise<void> {
    const store = await this.load(scope)
    delete store[key]
    await this.save(scope, store)
  }

  async list(scope: string): Promise<string[]> {
    const store = await this.load(scope)
    return Object.keys(store)
  }
}
