import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "fs"
import { dirname, join } from "path"
import { safeMatter } from "../../../setup/frontmatter/safeMatter"
import type { IGuardGateway } from "../domain/guard.gateway"
import type { IRuleFile, IToolCallRecord, RuleSource } from "../domain/guard.types"

export interface IGuardGatewayOptions {
  /** Tool-call record file, relative to the agent dir. */
  recordFile: string
  /** Rotate the record file to `<file>.1` once it passes this size. */
  recordMaxBytes: number
  /** Where the platform's protected rules live. Defaults to the bundled `baseline/` next to this file. */
  baselineDir?: string
}

/**
 * Rules as markdown files with YAML frontmatter — the SKILL.md convention,
 * so operators learn one format. Baseline rules ship with the runtime
 * (`data/baseline/*.md`), agent rules live in `<agentDir>/rules/*.md`.
 */
export class GuardGateway implements IGuardGateway {
  private readonly rulesDir: string
  private readonly baselineDir: string
  private readonly recordPath: string

  constructor(agentDir: string, private opts: IGuardGatewayOptions) {
    this.rulesDir = join(agentDir, "rules")
    this.baselineDir = opts.baselineDir ?? join(import.meta.dir, "baseline")
    this.recordPath = join(agentDir, opts.recordFile)
  }

  loadRuleFiles(): IRuleFile[] {
    return [
      ...this.readDir(this.baselineDir, "baseline"),
      ...this.readDir(this.rulesDir, "agent"),
    ]
  }

  async appendRecord(record: IToolCallRecord): Promise<void> {
    mkdirSync(dirname(this.recordPath), { recursive: true })
    this.rotateIfNeeded()
    appendFileSync(this.recordPath, JSON.stringify(record) + "\n")
  }

  private readDir(dir: string, source: RuleSource): IRuleFile[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith(".md") && !f.startsWith("."))
      .sort()
      .map(f => {
        const path = join(dir, f)
        const file = `${source === "baseline" ? "baseline" : "rules"}/${f}`
        try {
          const parsed = safeMatter(readFileSync(path, "utf-8"))
          return { file, source, data: parsed.data as Record<string, unknown>, body: parsed.content }
        } catch (err) {
          return { file, source, data: {}, body: "", error: `frontmatter did not parse: ${(err as Error).message}` }
        }
      })
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.recordPath) && statSync(this.recordPath).size >= this.opts.recordMaxBytes) {
        renameSync(this.recordPath, `${this.recordPath}.1`)
      }
    } catch {
      // Rotation is best-effort; a failed rename just means a bigger file.
    }
  }
}
