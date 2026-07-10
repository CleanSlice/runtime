import type { ISkillGateway } from "../domain/skill.gateway"
import type { Skill, SkillSource, SkillMetadata, RegistryEntry, SkillRegistry } from "../domain/skill.types"
import { existsSync, readdirSync, rmSync } from "fs"
import { join, resolve, dirname } from "path"
import matter from "gray-matter"

const REGISTRY_URL = "https://raw.githubusercontent.com/cleanslice/skills/main/registry.json"
const REGISTRY_CACHE_TTL = 60 * 60 * 1000 // 1 hour

export class SkillGateway implements ISkillGateway {
  private agentSkillsDir: string
  private bundledSkillsDir: string
  private registryCache: RegistryEntry[] | null = null
  private registryCacheTime = 0

  constructor(agentDir: string, bundledDir?: string) {
    this.agentSkillsDir = join(agentDir, "skills")
    // Bundled skills live in runtime/skills/ (sibling to src/)
    this.bundledSkillsDir = bundledDir ?? resolve(dirname(dirname(dirname(dirname(dirname(__dirname))))), "skills")
  }

  // ─── Load ────────────────────────────────────────────────────────────────────

  async loadAll(): Promise<Skill[]> {
    const skills = new Map<string, Skill>()

    // 1. Bundled skills (lowest priority)
    for (const skill of await this.loadFromDir(this.bundledSkillsDir, "bundled")) {
      skills.set(skill.name, skill)
    }

    // 2. Agent-specific skills (highest priority — override bundled)
    for (const skill of await this.loadFromDir(this.agentSkillsDir, "agent")) {
      skills.set(skill.name, skill)
    }

    return Array.from(skills.values())
  }

  async load(name: string): Promise<Skill | null> {
    // Agent skills take priority over bundled
    const agentSkill = await this.loadOne(this.agentSkillsDir, name, "agent")
    if (agentSkill) return agentSkill

    return this.loadOne(this.bundledSkillsDir, name, "bundled")
  }

  // ─── Install ─────────────────────────────────────────────────────────────────

  async install(nameOrUrl: string): Promise<Skill> {
    const isUrl = nameOrUrl.includes("/") && (nameOrUrl.includes("github.com") || nameOrUrl.includes("://"))

    if (isUrl) {
      return this.installFromUrl(nameOrUrl)
    }

    return this.installFromRegistry(nameOrUrl)
  }

  async remove(name: string): Promise<void> {
    const skillDir = join(this.agentSkillsDir, name)
    if (!existsSync(skillDir)) {
      throw new Error(`Skill not found: ${name}`)
    }
    rmSync(skillDir, { recursive: true, force: true })
  }

  // ─── Registry ────────────────────────────────────────────────────────────────

  async fetchRegistry(): Promise<RegistryEntry[]> {
    const now = Date.now()
    if (this.registryCache && (now - this.registryCacheTime) < REGISTRY_CACHE_TTL) {
      return this.registryCache
    }

    try {
      const res = await fetch(REGISTRY_URL)
      if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`)
      const data = await res.json() as SkillRegistry
      this.registryCache = data.skills ?? []
      this.registryCacheTime = now
      return this.registryCache
    } catch (err) {
      if (this.registryCache) return this.registryCache
      throw new Error(`Cannot fetch skill registry: ${(err as Error).message}`)
    }
  }

  async searchRegistry(query: string): Promise<RegistryEntry[]> {
    const entries = await this.fetchRegistry()
    const q = query.toLowerCase()
    const words = q.split(/\W+/).filter(w => w.length > 1)

    return entries
      .map(entry => {
        const text = `${entry.name} ${entry.description}`.toLowerCase()
        const score = words.filter(w => text.includes(w)).length
        return { entry, score }
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(r => r.entry)
  }

  // ─── Private: loading ────────────────────────────────────────────────────────

  private async loadFromDir(dir: string, source: SkillSource): Promise<Skill[]> {
    if (!existsSync(dir)) return []

    const skills: Skill[] = []
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skill = await this.loadOne(dir, entry.name, source)
      if (skill) skills.push(skill)
    }

    return skills
  }

  private async loadOne(dir: string, name: string, source: SkillSource): Promise<Skill | null> {
    const skillPath = join(dir, name, "SKILL.md")
    if (!existsSync(skillPath)) return null

    try {
      const raw = await Bun.file(skillPath).text()
      const { data, content } = matter(raw)

      const metadata: SkillMetadata = {}
      if (data.metadata) {
        const m = data.metadata as Record<string, unknown>
        metadata.emoji = m.emoji as string | undefined
        metadata.always = m.always as boolean | undefined
        if (m.requires) {
          const r = m.requires as Record<string, unknown>
          metadata.requires = {
            bins: r.bins as string[] | undefined,
            env: r.env as string[] | undefined,
          }
        }
      }

      return {
        name: (data.name as string) ?? name,
        description: (data.description as string) ?? "",
        path: skillPath,
        content: content.trim(),
        source,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
    } catch {
      return null
    }
  }

  // ─── Private: install helpers ────────────────────────────────────────────────

  private async installFromRegistry(name: string): Promise<Skill> {
    const entries = await this.fetchRegistry()
    const entry = entries.find(e => e.name === name)
    if (!entry) {
      throw new Error(`Skill "${name}" not found in registry. Run: cleanslice skills search ${name}`)
    }

    return this.cloneSkill(entry.repo, entry.path, name)
  }

  private async installFromUrl(url: string): Promise<Skill> {
    // Parse GitHub URL: https://github.com/user/repo/tree/main/path/to/skill
    // or shorthand: github.com/user/repo/path/to/skill
    const cleaned = url.replace(/^https?:\/\//, "").replace(/^github\.com\//, "")
    const parts = cleaned.split("/")

    if (parts.length < 2) {
      throw new Error(`Invalid GitHub URL: ${url}. Expected: github.com/user/repo[/path/to/skill]`)
    }

    const repo = `${parts[0]}/${parts[1]}`

    // Skip "tree/branch" if present
    let pathParts = parts.slice(2)
    if (pathParts[0] === "tree" && pathParts.length > 1) {
      pathParts = pathParts.slice(2) // skip "tree" and branch name
    }

    const skillPath = pathParts.join("/")
    const name = pathParts[pathParts.length - 1] || parts[1]

    return this.cloneSkill(repo, skillPath, name)
  }

  private async cloneSkill(repo: string, repoPath: string, name: string): Promise<Skill> {
    const targetDir = join(this.agentSkillsDir, name)

    if (existsSync(targetDir)) {
      throw new Error(`Skill "${name}" already installed at ${targetDir}. Remove first: cleanslice skills remove ${name}`)
    }

    // Use git sparse-checkout to fetch only the skill directory
    const tmpDir = join(this.agentSkillsDir, `.tmp-${name}-${Date.now()}`)

    try {
      const gitUrl = `https://github.com/${repo}.git`
      await this.exec(`git clone --depth 1 --filter=blob:none --sparse "${gitUrl}" "${tmpDir}"`)
      await this.exec(`git -C "${tmpDir}" sparse-checkout set "${repoPath}"`)

      // Move the skill directory to its final location
      const { mkdirSync, cpSync } = await import("fs")
      const srcDir = join(tmpDir, repoPath)

      if (!existsSync(srcDir)) {
        throw new Error(`Path "${repoPath}" not found in repo ${repo}`)
      }

      mkdirSync(targetDir, { recursive: true })
      cpSync(srcDir, targetDir, { recursive: true })
    } finally {
      // Clean up temp clone
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    }

    // Load and return the installed skill
    const skill = await this.loadOne(this.agentSkillsDir, name, "installed")
    if (!skill) {
      throw new Error(`Installed skill "${name}" but no SKILL.md found. Check the repo structure.`)
    }

    return skill
  }

  private async exec(cmd: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Never prompt on the terminal — remote users can't answer it. Fail fast instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes" },
    })

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`Command failed (${exitCode}): ${cmd}\n${stderr}`)
    }

    return await new Response(proc.stdout).text()
  }
}
