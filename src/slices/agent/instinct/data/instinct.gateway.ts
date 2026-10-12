import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import matter from "gray-matter"
import type { IInstinctGateway } from "../domain/instinct.gateway"
import type { IInstinct } from "../domain/instinct.types"
import { createLogger } from "../../../setup/logger"

const log = createLogger("instinct")

/**
 * One markdown file per behaviour under `memory/instincts/` — readable,
 * diffable, synced like everything else in the agent dir. Frontmatter holds
 * the fields, the body holds `## Action`.
 */
export class InstinctGateway implements IInstinctGateway {
  private readonly dir: string
  private readonly statePath: string
  private readonly skillsDir: string
  private warned = new Set<string>()

  constructor(private agentDir: string) {
    this.dir = join(agentDir, "memory", "instincts")
    this.statePath = join(agentDir, "data", "instincts.json")
    this.skillsDir = join(agentDir, "skills")
  }

  list(): IInstinct[] {
    if (!existsSync(this.dir)) return []
    const out: IInstinct[] = []
    for (const f of readdirSync(this.dir).filter(f => f.endsWith(".md")).sort()) {
      const path = join(this.dir, f)
      try {
        const parsed = matter(readFileSync(path, "utf8"))
        const i = fromFile(parsed.data as Record<string, unknown>, parsed.content)
        if (i) out.push(i)
        else this.warnOnce(f, "missing id, trigger or action")
      } catch (err) {
        this.warnOnce(f, (err as Error).message)
      }
    }
    return out
  }

  write(i: IInstinct): void {
    mkdirSync(this.dir, { recursive: true })
    const { action, ...fields } = i
    const front = matter.stringify(`## Action\n\n${action.trim()}\n`, fields)
    writeFileSync(join(this.dir, `${i.id}.md`), front)
  }

  remove(id: string): void {
    rmSync(join(this.dir, `${id}.md`), { force: true })
  }

  readLastDecay(): number | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as { lastDecay?: number }
      return typeof raw.lastDecay === "number" ? raw.lastDecay : undefined
    } catch {
      return undefined
    }
  }

  writeLastDecay(ts: number): void {
    mkdirSync(join(this.agentDir, "data"), { recursive: true })
    writeFileSync(this.statePath, JSON.stringify({ lastDecay: ts }, null, 2) + "\n")
  }

  writeSkill(slug: string, description: string, content: string): string {
    const name = `learned-${slug}`
    const dir = join(this.skillsDir, name)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "SKILL.md")
    writeFileSync(path, `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${content.trim()}\n`)
    return path
  }

  private warnOnce(file: string, why: string): void {
    if (this.warned.has(file)) return
    this.warned.add(file)
    log.warn(`skipping instincts/${file}: ${why}`)
  }
}

function fromFile(d: Record<string, unknown>, body: string): IInstinct | null {
  const action = body.replace(/^\s*## Action\s*/i, "").trim()
  if (typeof d.id !== "string" || typeof d.trigger !== "string" || !action) return null
  return {
    id: d.id,
    trigger: d.trigger,
    action,
    confidence: typeof d.confidence === "number" ? d.confidence : 0.5,
    scope: d.scope === "shared" ? "shared" : "agent",
    source: (["correction", "error-resolution", "repetition", "explicit-rule"].includes(d.source as string) ? d.source : "repetition") as IInstinct["source"],
    pinned: d.pinned === true,
    evidence: Array.isArray(d.evidence) ? (d.evidence as IInstinct["evidence"]) : [],
    created: typeof d.created === "number" ? d.created : 0,
    reinforced: typeof d.reinforced === "number" ? d.reinforced : 0,
    ...(typeof d.promotedTo === "string" ? { promotedTo: d.promotedTo } : {}),
    ...(typeof d.conflictsWith === "string" ? { conflictsWith: d.conflictsWith } : {}),
  }
}
