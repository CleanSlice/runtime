import { existsSync, readdirSync } from "fs"
import { join } from "path"
import type {
  ISessionGateway,
  IRuntimeSession,
  ILoginInstruction,
} from "../../../domain/session.types"

// Standalone adapter — no host backend. The runtime runs with no Ranch
// (or any) host: logged-in cookies are JSON files the operator drops
// into `<agentDir>/sessions/`.
//
//   <agentDir>/sessions/x:dimzhuk.json   → a Playwright storageState
//                                          (or { userAgent, storageState })
//   <agentDir>/sessions/secrets.json     → { "OPENAI_API_KEY": "…", … }
//
// Selected by SessionModule when no host API URL is configured.
export class LocalSessionRepository implements ISessionGateway {
  private dir: string

  constructor(agentDir: string) {
    this.dir = join(agentDir, "sessions")
  }

  async list(): Promise<IRuntimeSession[]> {
    if (!existsSync(this.dir)) return []
    const out: IRuntimeSession[] = []
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || file === "secrets.json") continue
      const profile = file.slice(0, -".json".length)
      const idx = profile.indexOf(":")
      out.push({
        service: idx >= 0 ? profile.slice(0, idx) : profile,
        accountKey: idx >= 0 ? profile.slice(idx + 1) : "default",
        profile,
        mechanism: "browser",
        status: "connected",
      })
    }
    return out
  }

  async getBrowserState(profile: string): Promise<unknown | null> {
    const path = join(this.dir, `${profile}.json`)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(await Bun.file(path).text())
    } catch {
      return null
    }
  }

  async requestLogin(
    service: string,
    accountKey: string,
  ): Promise<ILoginInstruction | null> {
    // No host UI to send the user to — return self-host instructions.
    const profile = `${service}:${accountKey}`
    return {
      accountId: profile,
      siteUrl: "",
      helpUrl: "",
      instructions:
        `No session host is configured. To connect "${profile}": log in ` +
        `to the site in a normal browser, export its cookies as a ` +
        `Playwright storageState JSON, and save the file as ` +
        `sessions/${profile}.json inside this agent's directory.`,
    }
  }

  async resolveSecrets(_service?: string): Promise<Record<string, string>> {
    // Local secrets.json is a flat env map with no service dimension —
    // `_service` filtering does not apply; return the whole map.
    const path = join(this.dir, "secrets.json")
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(await Bun.file(path).text()) as Record<string, string>
    } catch {
      return {}
    }
  }
}
