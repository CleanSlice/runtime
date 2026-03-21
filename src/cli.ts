#!/usr/bin/env bun
/**
 * CleanSlice Runtime CLI
 * Usage: cleanslice <command> [options]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve, join } from "path"
import { randomUUID } from "crypto"
import { InitModule, AGENT_SUBDIRS } from "./slices/agent/init"

const VERSION = "0.1.0"
const AGENT_DIR = resolve(process.env.CLEANSLICE_AGENT_DIR ?? ".agent")

// ─── Helpers ────────────────────────────────────────────────────────────────

function bold(s: string) { return `\x1b[1m${s}\x1b[0m` }
function dim(s: string) { return `\x1b[2m${s}\x1b[0m` }
function green(s: string) { return `\x1b[32m${s}\x1b[0m` }
function red(s: string) { return `\x1b[31m${s}\x1b[0m` }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m` }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m` }

function ok(msg: string) { console.log(`${green("✓")} ${msg}`) }
function fail(msg: string) { console.error(`${red("✗")} ${msg}`); process.exit(1) }
function warn(msg: string) { console.warn(`${yellow("!")} ${msg}`) }
function info(msg: string) { console.log(`${cyan("·")} ${msg}`) }

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T }
  catch { return fallback }
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function ensureAgentDir() {
  if (!existsSync(AGENT_DIR)) fail(`No .agent directory found at ${AGENT_DIR}. Run: cleanslice init`)
}

function parseArgs(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      if (args[i + 1] && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i]
      } else {
        flags[key] = true
      }
    } else {
      positional.push(args[i])
    }
  }
  return { flags, positional }
}

// ─── Commands ────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, {
  description: string
  usage: string
  run: (args: string[]) => Promise<void> | void
}> = {

  // ── init ──────────────────────────────────────────────────────────────────
  init: {
    description: "Scaffold a new .agent directory",
    usage: "cleanslice init [--dir <path>] [--name <agent-name>]",
    run(args) {
      const { flags } = parseArgs(args)
      const dir = resolve((flags.dir as string) ?? ".agent")
      const exampleDir = resolve(".agent.example")

      if (existsSync(dir) && existsSync(join(dir, "SOUL.md")) && existsSync(join(dir, "agent.config.json"))) {
        warn(`${dir} already exists. Use --dir to specify another path.`)
        return
      }

      // InitModule handles bootstrap (copy from .agent.example) + config loading
      new InitModule(dir, exampleDir)

      // Ensure required subdirectories exist (bootstrap also does this, but just in case)
      for (const sub of AGENT_SUBDIRS) {
        mkdirSync(join(dir, sub), { recursive: true })
      }

      // Fallback: create files that don't exist yet (in case .agent.example is missing some)
      const fallbackFiles: Record<string, string> = {
        "SOUL.md": `# SOUL.md — Who You Are\n\n_You're not a chatbot. You're becoming someone._\n\n## Core Truths\n\n- Be genuinely helpful, not performatively helpful\n- Have opinions. You're allowed to disagree\n- Be resourceful before asking\n- Earn trust through competence\n`,
        "USER.md": `# USER.md — About Your Human\n\n- **Name:** Unknown\n- **Timezone:** UTC\n\n_Update this file as you learn about the person you're helping._\n`,
        "MEMORY.md": `# MEMORY.md — Long-Term Memory\n\n_Add significant events, decisions, lessons learned here._\n`,
        "HEARTBEAT.md": `# HEARTBEAT.md\n\n_Add periodic tasks here. The agent checks this every 30 minutes._\n\n## Tasks\n\n(empty)\n`,
        "skills/README.md": `# Skills\n\nAdd subdirectories here, each with a \`SKILL.md\` file.\n\nExample:\n\`\`\`\nskills/\n  weather/\n    SKILL.md    ← frontmatter: name, description + instructions\n\`\`\`\n\nFrontmatter format:\n\`\`\`md\n---\nname: weather\ndescription: Get current weather and forecasts for any location\n---\n\n# Weather Skill\n...\n\`\`\`\n`,
      }

      for (const [filename, content] of Object.entries(fallbackFiles)) {
        const filePath = join(dir, filename)
        if (!existsSync(filePath)) {
          writeFileSync(filePath, content)
          ok(`Created ${filePath}`)
        }
      }

      // Write minimal .env.example
      const envPath = resolve(".env.example")
      if (!existsSync(envPath)) {
        writeFileSync(envPath, [
          "# CleanSlice Runtime — environment variables",
          "TELEGRAM_BOT_TOKEN=your-telegram-bot-token",
          "TELEGRAM_BOT_ADMIN_IDS=your-telegram-user-id",
          "# SLACK_BOT_TOKEN=xoxb-...",
          "# SLACK_APP_TOKEN=xapp-...",
          "# CLAUDE_CODE_OAUTH_TOKEN=...",
          "# CLEANSLICE_AGENT_DIR=.agent",
        ].join("\n") + "\n")
        ok(`Created .env.example`)
      }

      console.log()
      ok(bold(`Agent scaffold ready at ${dir}/`))
      console.log()
      info("Next steps:")
      console.log(`  1. Copy .env.example → .env and fill in your tokens`)
      console.log(`  2. Edit ${dir}/SOUL.md — define your agent's personality`)
      console.log(`  3. Edit ${dir}/agent.config.json — tune runtime settings`)
      console.log(`  4. Run: ${bold("cleanslice start")}`)
    }
  },

  // ── start ─────────────────────────────────────────────────────────────────
  start: {
    description: "Start the agent runtime (foreground)",
    usage: "cleanslice start [--dir <agent-dir>]",
    async run(args) {
      const { flags } = parseArgs(args)
      const dir = (flags.dir as string) ?? AGENT_DIR
      info(`Starting agent runtime (dir=${dir})…`)
      // Delegate to index.ts — just re-exec with the right env
      const { spawnSync } = await import("child_process")
      const result = spawnSync("bun", ["run", "src/index.ts"], {
        stdio: "inherit",
        env: { ...process.env, CLEANSLICE_AGENT_DIR: dir }
      })
      process.exit(result.status ?? 0)
    }
  },

  // ── cron ──────────────────────────────────────────────────────────────────
  cron: {
    description: "Manage cron jobs",
    usage: "cleanslice cron <list|add|remove|enable|disable>",
    async run(args) {
      ensureAgentDir()
      const [sub, ...rest] = args
      const cronPath = join(AGENT_DIR, "data", "cron.json")
      const jobs = readJson<Record<string, unknown>[]>(cronPath, [])

      if (!sub || sub === "list") {
        if (jobs.length === 0) { info("No cron jobs."); return }
        console.log()
        console.log(bold("  ID".padEnd(12)) + bold("Name".padEnd(30)) + bold("Schedule".padEnd(20)) + bold("Enabled"))
        console.log("  " + "─".repeat(72))
        for (const j of jobs) {
          const id = String(j.id ?? "").slice(0, 8)
          const name = String(j.name ?? "").slice(0, 28).padEnd(28)
          const sched = String(j.schedule ?? "").padEnd(18)
          const enabled = j.enabled ? green("✓") : red("✗")
          console.log(`  ${dim(id)}  ${name}  ${cyan(sched)}  ${enabled}`)
        }
        console.log()
        return
      }

      if (sub === "add") {
        const { flags } = parseArgs(rest)
        const name = flags.name as string
        const schedule = flags.schedule as string
        const message = flags.message as string
        const to = flags.to as string | undefined
        const channel = flags.channel as string | undefined
        const tz = flags.tz as string | undefined

        if (!name || !schedule || !message) {
          fail("Required: --name, --schedule, --message\nExample: cleanslice cron add --name \"Daily digest\" --schedule \"0 9 * * *\" --message \"Send morning digest\" --to 12345 --channel telegram")
        }

        const job = { id: randomUUID(), name, schedule, tz, message, to, channel, enabled: true }
        jobs.push(job)
        mkdirSync(join(AGENT_DIR, "data"), { recursive: true })
        writeJson(cronPath, jobs)
        ok(`Cron job added: ${bold(name)} (${schedule})`)
        info(`ID: ${job.id}`)
        return
      }

      if (sub === "remove") {
        const [id] = rest
        if (!id) fail("Usage: cleanslice cron remove <id>")
        const before = jobs.length
        const filtered = jobs.filter(j => !String(j.id).startsWith(id))
        if (filtered.length === before) fail(`No job found with ID starting with: ${id}`)
        writeJson(cronPath, filtered)
        ok(`Removed ${before - filtered.length} job(s)`)
        return
      }

      if (sub === "enable" || sub === "disable") {
        const [id] = rest
        if (!id) fail(`Usage: cleanslice cron ${sub} <id>`)
        let found = false
        for (const j of jobs) {
          if (String(j.id).startsWith(id)) {
            j.enabled = sub === "enable"
            found = true
          }
        }
        if (!found) fail(`No job found with ID starting with: ${id}`)
        writeJson(cronPath, jobs)
        ok(`Job ${sub}d`)
        return
      }

      fail(`Unknown cron subcommand: ${sub}. Try: list, add, remove, enable, disable`)
    }
  },

  // ── memory ────────────────────────────────────────────────────────────────
  memory: {
    description: "View or clear agent memory",
    usage: "cleanslice memory <show|clear>",
    run(args) {
      ensureAgentDir()
      const [sub] = args
      const memPath = join(AGENT_DIR, "MEMORY.md")

      if (!sub || sub === "show") {
        if (!existsSync(memPath)) { info("No MEMORY.md found."); return }
        console.log(readFileSync(memPath, "utf-8"))
        return
      }

      if (sub === "clear") {
        writeFileSync(memPath, "# MEMORY.md — Long-Term Memory\n\n_Cleared._\n")
        ok("Memory cleared")
        return
      }

      fail(`Unknown subcommand: ${sub}. Try: show, clear`)
    }
  },

  // ── sessions ──────────────────────────────────────────────────────────────
  sessions: {
    description: "List or clear sessions",
    usage: "cleanslice sessions <list|clear> [--channel <name>]",
    run(args) {
      ensureAgentDir()
      const [sub] = args
      const { flags } = parseArgs(args.slice(1))
      const sessionsDir = join(AGENT_DIR, "sessions")

      if (!existsSync(sessionsDir)) { info("No sessions directory."); return }

      const { readdirSync, statSync } = require("fs") as typeof import("fs")
      const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith(".json"))

      if (!sub || sub === "list") {
        if (files.length === 0) { info("No sessions."); return }
        console.log()
        console.log(bold("  Session ID".padEnd(40)) + bold("Messages".padEnd(12)) + bold("Last active"))
        console.log("  " + "─".repeat(70))
        for (const f of files) {
          const data = readJson<{ id?: string; events?: unknown[] }>(join(sessionsDir, f), {})
          const stat = statSync(join(sessionsDir, f))
          const id = String(data.id ?? f.replace(".json", "")).slice(0, 36).padEnd(38)
          const count = String((data.events ?? []).length).padEnd(10)
          const lastActive = stat.mtime.toISOString().slice(0, 16)
          console.log(`  ${cyan(id)}  ${dim(count)}  ${lastActive}`)
        }
        console.log()
        info(`Total: ${files.length} session(s)`)
        return
      }

      if (sub === "clear") {
        const { rmSync } = require("fs") as typeof import("fs")
        for (const f of files) rmSync(join(sessionsDir, f))
        ok(`Cleared ${files.length} session(s)`)
        return
      }

      fail(`Unknown subcommand: ${sub}. Try: list, clear`)
    }
  },

  // ── status ────────────────────────────────────────────────────────────────
  status: {
    description: "Show agent directory status",
    usage: "cleanslice status",
    run() {
      console.log()
      console.log(bold("  CleanSlice Runtime") + dim(` v${VERSION}`))
      console.log()

      const checks: [string, () => string][] = [
        ["Agent dir", () => existsSync(AGENT_DIR) ? green(AGENT_DIR) : red(`${AGENT_DIR} (not found)`)],
        ["SOUL.md", () => existsSync(join(AGENT_DIR, "SOUL.md")) ? green("✓") : yellow("missing")],
        ["USER.md", () => existsSync(join(AGENT_DIR, "USER.md")) ? green("✓") : yellow("missing")],
        ["MEMORY.md", () => existsSync(join(AGENT_DIR, "MEMORY.md")) ? green("✓") : yellow("missing")],
        ["HEARTBEAT.md", () => existsSync(join(AGENT_DIR, "HEARTBEAT.md")) ? green("✓") : dim("optional, missing")],
        [".env", () => existsSync(".env") ? green("✓") : red("missing — copy .env.example")],
        ["Cron jobs", () => {
          const jobs = readJson<unknown[]>(join(AGENT_DIR, "data", "cron.json"), [])
          const enabled = jobs.filter((j: any) => j.enabled).length
          return jobs.length > 0 ? green(`${enabled}/${jobs.length} enabled`) : dim("none")
        }],
        ["Sessions", () => {
          if (!existsSync(join(AGENT_DIR, "sessions"))) return dim("0")
          const { readdirSync } = require("fs") as typeof import("fs")
          const count = readdirSync(join(AGENT_DIR, "sessions")).filter((f: string) => f.endsWith(".json")).length
          return count > 0 ? cyan(String(count)) : dim("0")
        }],
        ["TELEGRAM_BOT_TOKEN", () => process.env.TELEGRAM_BOT_TOKEN ? green("✓ set") : red("not set")],
        ["TELEGRAM_BOT_ADMIN_IDS", () => process.env.TELEGRAM_BOT_ADMIN_IDS ? green(process.env.TELEGRAM_BOT_ADMIN_IDS) : yellow("not set")],
      ]

      for (const [label, check] of checks) {
        const pad = label.padEnd(16)
        try {
          console.log(`  ${dim(pad)}  ${check()}`)
        } catch {
          console.log(`  ${dim(pad)}  ${red("error")}`)
        }
      }
      console.log()
    }
  },

  // ── skills ────────────────────────────────────────────────────────────────
  skills: {
    description: "List or inspect skills",
    usage: "cleanslice skills <list|show <name>>",
    async run(args) {
      ensureAgentDir()
      const [sub, name] = args
      const skillsDir = join(AGENT_DIR, "skills")

      if (!existsSync(skillsDir)) {
        info(`No skills directory at ${skillsDir}`)
        info(`Create it with: mkdir -p ${skillsDir}/<skill-name> && touch ${skillsDir}/<skill-name>/SKILL.md`)
        return
      }

      const { readdirSync, statSync } = require("fs") as typeof import("fs")
      const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
        .filter((e: any) => e.isDirectory())
        .map((e: any) => e.name)

      if (!sub || sub === "list") {
        if (skillDirs.length === 0) { info("No skills found."); return }
        console.log()
        for (const dir of skillDirs) {
          const skillPath = join(skillsDir, dir, "SKILL.md")
          if (!existsSync(skillPath)) {
            console.log(`  ${yellow(dir.padEnd(20))} ${dim("(no SKILL.md)")}`)
            continue
          }
          // Parse frontmatter manually (avoid importing gray-matter in CLI)
          const content = readFileSync(skillPath, "utf-8")
          const descMatch = content.match(/description:\s*['"]?(.+?)['"]?\n/)
          const desc = descMatch ? descMatch[1].slice(0, 60) : dim("no description")
          console.log(`  ${cyan(dir.padEnd(20))} ${desc}`)
        }
        console.log()
        info(`Total: ${skillDirs.length} skill(s) in ${skillsDir}`)
        return
      }

      if (sub === "show") {
        if (!name) fail("Usage: cleanslice skills show <name>")
        const skillPath = join(skillsDir, name, "SKILL.md")
        if (!existsSync(skillPath)) fail(`Skill not found: ${name}`)
        console.log(readFileSync(skillPath, "utf-8"))
        return
      }

      fail(`Unknown subcommand: ${sub}. Try: list, show`)
    }
  },

  // ── version ───────────────────────────────────────────────────────────────
  version: {
    description: "Show version",
    usage: "cleanslice version",
    run() { console.log(VERSION) }
  },

}

// ─── Help ────────────────────────────────────────────────────────────────────

function showHelp(command?: string) {
  if (command && COMMANDS[command]) {
    const cmd = COMMANDS[command]
    console.log()
    console.log(bold(command))
    console.log(`  ${cmd.description}`)
    console.log()
    console.log(`  ${dim("Usage:")} ${cmd.usage}`)
    console.log()
    return
  }

  console.log()
  console.log(bold("cleanslice") + dim(` v${VERSION}`) + " — Agent runtime for CleanSlice")
  console.log()
  console.log(bold("Usage:"))
  console.log("  cleanslice <command> [options]")
  console.log()
  console.log(bold("Commands:"))
  const maxLen = Math.max(...Object.keys(COMMANDS).map(k => k.length))
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${cyan(name.padEnd(maxLen + 2))}${cmd.description}`)
  }
  console.log()
  console.log(bold("Options:"))
  console.log(`  ${cyan("--help")}    Show help for a command`)
  console.log(`  ${cyan("--version")} Show version`)
  console.log()
  console.log(dim("  CLEANSLICE_AGENT_DIR env var overrides the default .agent directory"))
  console.log()
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  showHelp(rest[0])
  process.exit(0)
}

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION)
  process.exit(0)
}

const command = COMMANDS[cmd]
if (!command) {
  console.error(red(`Unknown command: ${cmd}`))
  console.error(`Run ${bold("cleanslice --help")} for a list of commands`)
  process.exit(1)
}

if (rest.includes("--help") || rest.includes("-h")) {
  showHelp(cmd)
  process.exit(0)
}

Promise.resolve(command.run(rest)).catch(err => {
  console.error(red("Error:"), err.message ?? err)
  process.exit(1)
})
