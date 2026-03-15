import { existsSync, mkdirSync } from "fs"
import { join } from "path"

/**
 * VoiceModule — tracks which users have voice mode enabled.
 * Persisted to {agentDir}/data/voice.json
 */
export class VoiceModule {
  private path: string
  private enabled: Set<string> = new Set()

  constructor(agentDir: string) {
    mkdirSync(join(agentDir, "data"), { recursive: true })
    this.path = join(agentDir, "data", "voice.json")
    this.load()
  }

  private load(): void {
    try {
      const data = JSON.parse(require("fs").readFileSync(this.path, "utf-8")) as string[]
      this.enabled = new Set(data)
    } catch {
      this.enabled = new Set()
    }
  }

  private save(): void {
    require("fs").writeFileSync(this.path, JSON.stringify([...this.enabled], null, 2))
  }

  isEnabled(userId: string): boolean {
    return this.enabled.has(userId)
  }

  enable(userId: string): void {
    this.enabled.add(userId)
    this.save()
  }

  disable(userId: string): void {
    this.enabled.delete(userId)
    this.save()
  }

  toggle(userId: string): boolean {
    if (this.isEnabled(userId)) {
      this.disable(userId)
      return false
    } else {
      this.enable(userId)
      return true
    }
  }
}
