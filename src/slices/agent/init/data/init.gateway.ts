import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync } from "fs"
import { join } from "path"
import type { IInitGateway } from "../domain/init.gateway"
import type { IAgentConfig } from "../domain/init.types"
import { AGENT_CONFIG_DEFAULTS, AGENT_SUBDIRS } from "../domain/init.types"

export class InitGateway implements IInitGateway {
  scaffold(agentDir: string, exampleDir: string): void {
    if (this.isInitialized(agentDir)) return

    this.ensureDirs(agentDir)

    if (existsSync(exampleDir)) {
      console.log(`[init] first run — initializing ${agentDir} from ${exampleDir}`)
      this.copyDirRecursive(exampleDir, agentDir)
      console.log(`[init] agent directory ready`)
    } else {
      console.log(`[init] no example dir at ${exampleDir}, created minimal scaffold`)
    }
  }

  loadConfig(agentDir: string): IAgentConfig {
    const configPath = join(agentDir, "agent.config.json")

    if (!existsSync(configPath)) {
      console.log(`[init] no agent.config.json, using defaults`)
      return structuredClone(AGENT_CONFIG_DEFAULTS)
    }

    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"))
      const config = deepMerge(AGENT_CONFIG_DEFAULTS, raw) as IAgentConfig
      console.log(`[init] config loaded`)
      return config
    } catch (err) {
      console.error(`[init] failed to parse agent.config.json:`, err)
      return structuredClone(AGENT_CONFIG_DEFAULTS)
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private isInitialized(agentDir: string): boolean {
    return existsSync(join(agentDir, "SOUL.md")) && existsSync(join(agentDir, "agent.config.json"))
  }

  private ensureDirs(agentDir: string): void {
    for (const sub of AGENT_SUBDIRS) {
      mkdirSync(join(agentDir, sub), { recursive: true })
    }
  }

  private copyDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true })
    }

    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry)
      const destPath = join(dest, entry)

      if (statSync(srcPath).isDirectory()) {
        this.copyDirRecursive(srcPath, destPath)
      } else if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath)
        console.log(`[init] created ${entry}`)
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(defaults: any, override: any): any {
  const result = { ...defaults }
  for (const key of Object.keys(override)) {
    const val = override[key]
    const def = defaults[key]
    if (val !== null && typeof val === "object" && !Array.isArray(val) && def && typeof def === "object" && !Array.isArray(def)) {
      result[key] = deepMerge(def, val)
    } else {
      result[key] = val
    }
  }
  return result
}
