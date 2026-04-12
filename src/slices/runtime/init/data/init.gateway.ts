import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync } from "fs"
import { join } from "path"
import type { IInitGateway } from "../domain/init.gateway"
import type { IAgentConfig } from "../domain/init.types"
import { AGENT_CONFIG_DEFAULTS, AGENT_SUBDIRS } from "../domain/init.types"

export class InitGateway implements IInitGateway {
  scaffold(agentDir: string, exampleDir: string): void {
    if (this.isInitialized(agentDir)) {
      // Load config to determine what to sync
      const config = this.loadConfig(agentDir)

      if (config.managedFiles.length > 0) {
        this.syncManagedFiles(agentDir, exampleDir, config.managedFiles)
      }
      if (config.syncSkills) {
        this.syncSkills(agentDir, exampleDir)
      }
      return
    }

    this.ensureDirs(agentDir)

    if (existsSync(exampleDir)) {
      const count = this.copyDirRecursive(exampleDir, agentDir)
      console.log(`[init] first run — created ${count} files from ${exampleDir}`)
    } else {
      console.log(`[init] first run — created minimal scaffold`)
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
    // Create parent directory first
    try {
      mkdirSync(agentDir, { recursive: true })
      console.log(`[init] ✓ created agent directory: ${agentDir}`)
    } catch (err: unknown) {
      const code = (err as any)?.code
      if (code === "EACCES") {
        console.warn(`[init] permission denied creating ${agentDir}, cannot proceed`)
        throw err
      }
      console.warn(`[init] could not create parent dir: ${(err as any)?.message}`)
      throw err
    }

    // Create subdirectories with strict error handling
    // All subdirs MUST be created successfully or fail hard
    for (const sub of AGENT_SUBDIRS) {
      try {
        const subPath = join(agentDir, sub)
        mkdirSync(subPath, { recursive: true })
        console.log(`[init] ✓ created ${sub} directory`)
      } catch (err: unknown) {
        const code = (err as any)?.code
        const message = (err as any)?.message
        console.error(`[init] ✗ FATAL: cannot create ${sub} directory: ${message}`)
        throw err
      }
    }

    console.log(`[init] ✓ All agent directories ready`)
  }

  /**
   * Overwrite managed files from example on every startup.
   * Only files listed in config.managedFiles are touched.
   */
  private syncManagedFiles(agentDir: string, exampleDir: string, files: string[]): void {
    if (!existsSync(exampleDir)) return

    for (const file of files) {
      const src = join(exampleDir, file)
      const dest = join(agentDir, file)
      if (!existsSync(src)) continue

      try {
        const srcContent = readFileSync(src, "utf-8")
        const destContent = existsSync(dest) ? readFileSync(dest, "utf-8") : ""

        if (srcContent !== destContent) {
          copyFileSync(src, dest)
          console.log(`[init] updated managed file: ${file}`)
        }
      } catch (err: unknown) {
        const code = (err as any)?.code
        if (code === "EACCES") {
          console.warn(`[init] permission denied updating ${file}, skipping`)
        } else {
          throw err
        }
      }
    }
  }

  /**
   * Sync skills from exampleDir/skills/ into agentDir/skills/.
   * - Skills in example → overwritten in agent (version updates)
   * - Skills only in agent (user-created) → left untouched
   * - Skills only in example (new) → added to agent
   */
  private syncSkills(agentDir: string, exampleDir: string): void {
    const srcSkills = join(exampleDir, "skills")
    const destSkills = join(agentDir, "skills")
    if (!existsSync(srcSkills)) return

    try {
      mkdirSync(destSkills, { recursive: true })
    } catch (err: unknown) {
      const code = (err as any)?.code
      if (code === "EACCES") {
        console.warn(`[init] permission denied for skills dir, skipping sync`)
        return
      }
      throw err
    }

    for (const entry of readdirSync(srcSkills)) {
      const srcPath = join(srcSkills, entry)
      if (!statSync(srcPath).isDirectory()) continue

      const destPath = join(destSkills, entry)
      try {
        this.overwriteDirRecursive(srcPath, destPath)
        console.log(`[init] synced skill: ${entry}`)
      } catch (err: unknown) {
        const code = (err as any)?.code
        if (code === "EACCES") {
          console.warn(`[init] permission denied syncing skill ${entry}, skipping`)
        } else {
          throw err
        }
      }
    }
  }

  /** Copy directory, overwriting existing files (for managed content like skills) */
  private overwriteDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true })

    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry)
      const destPath = join(dest, entry)

      if (statSync(srcPath).isDirectory()) {
        this.overwriteDirRecursive(srcPath, destPath)
      } else {
        copyFileSync(srcPath, destPath)
      }
    }
  }

  private copyDirRecursive(src: string, dest: string): number {
    try {
      if (!existsSync(dest)) {
        mkdirSync(dest, { recursive: true })
      }
    } catch (err: unknown) {
      const code = (err as any)?.code
      if (code === "EACCES") {
        console.warn(`[init] permission denied creating ${dest}, skipping`)
        return 0
      }
      throw err
    }

    let count = 0
    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry)
      const destPath = join(dest, entry)

      if (statSync(srcPath).isDirectory()) {
        count += this.copyDirRecursive(srcPath, destPath)
      } else if (!existsSync(destPath)) {
        try {
          copyFileSync(srcPath, destPath)
          count++
        } catch (err: unknown) {
          const code = (err as any)?.code
          if (code === "EACCES") {
            console.warn(`[init] permission denied copying ${entry}, skipping`)
          } else {
            throw err
          }
        }
      }
    }
    return count
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
