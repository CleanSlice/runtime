import type { IVoiceGateway } from "../domain/voice.gateway"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

export class VoiceGateway implements IVoiceGateway {
  private path: string

  constructor(agentDir: string) {
    mkdirSync(join(agentDir, "data"), { recursive: true })
    this.path = join(agentDir, "data", "voice.json")
  }

  load(): string[] {
    try {
      if (!existsSync(this.path)) return []
      return JSON.parse(readFileSync(this.path, "utf-8")) as string[]
    } catch {
      return []
    }
  }

  save(userIds: string[]): void {
    writeFileSync(this.path, JSON.stringify(userIds, null, 2))
  }
}
