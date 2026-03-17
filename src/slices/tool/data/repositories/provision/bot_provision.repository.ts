import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { execSync, execFileSync } from "child_process"
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs"
import { join } from "path"

const BOT_SERVER = process.env.BOT_SERVER_HOST ?? "161.35.200.87"
const BOT_SERVER_USER = process.env.BOT_SERVER_USER ?? "root"
const RUNTIME_IMAGE = process.env.RUNTIME_IMAGE ?? "ghcr.io/cleanslice/runtime:latest"

function getKeyPath(): string {
  const keyContent = process.env.BOT_SERVER_SSH_KEY
  if (!keyContent) throw new Error("BOT_SERVER_SSH_KEY env var not set")

  const keyDir = "/tmp/.ssh-provision"
  mkdirSync(keyDir, { recursive: true })
  const keyPath = join(keyDir, "id_provision")

  writeFileSync(keyPath, keyContent, { mode: 0o600 })
  return keyPath
}

function ssh(command: string): string {
  const keyPath = getKeyPath()
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "-i", keyPath,
    `${BOT_SERVER_USER}@${BOT_SERVER}`,
    command,
  ]
  try {
    return execFileSync("ssh", args, { encoding: "utf-8", timeout: 60_000 }).trim()
  } catch (err: any) {
    throw new Error(err.stderr?.toString() || err.message)
  }
}

// ─── bot_provision ─────────────────────────────────────────────────────────────

const provisionSchema = z.object({
  bot_id: z.string().describe("Unique bot identifier (e.g. 'user_123' or 'tenant_abc')"),
  telegram_token: z.string().describe("Telegram bot token"),
  claude_token: z.string().describe("Claude Code OAuth token"),
  extra_env: z.record(z.string()).optional().describe("Additional environment variables"),
})

export const BotProvisionTool: Tool = {
  name: "bot_provision",
  description: "Provision a new bot instance on the Bot Server Droplet. Pulls the runtime image, starts a Docker container with the given credentials, and returns the container ID.",
  schema: provisionSchema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { bot_id, telegram_token, claude_token, extra_env } = provisionSchema.parse(params)

    const containerName = `bot-${bot_id}`

    // Build env args
    const envArgs = [
      `-e TELEGRAM_TOKEN=${telegram_token}`,
      `-e CLAUDE_CODE_OAUTH_TOKEN=${claude_token}`,
      `-e S3_BUCKET=${process.env.S3_BUCKET ?? ""}`,
      `-e S3_PREFIX=bots/${bot_id}/agent-data`,
      `-e AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID ?? ""}`,
      `-e AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY ?? ""}`,
      `-e AWS_REGION=${process.env.AWS_REGION ?? "us-east-1"}`,
    ]

    if (extra_env) {
      for (const [key, val] of Object.entries(extra_env)) {
        envArgs.push(`-e ${key}=${val}`)
      }
    }

    // Stop and remove existing container if any
    try {
      ssh(`docker rm -f ${containerName} 2>/dev/null || true`)
    } catch {}

    // Pull latest image
    ssh(`docker pull ${RUNTIME_IMAGE}`)

    // Start container
    const containerId = ssh(
      `docker run -d --name ${containerName} --restart unless-stopped ${envArgs.join(" ")} ${RUNTIME_IMAGE}`
    )

    return {
      ok: true,
      bot_id,
      container_name: containerName,
      container_id: containerId.slice(0, 12),
      image: RUNTIME_IMAGE,
    }
  },
}

// ─── bot_deprovision ───────────────────────────────────────────────────────────

const deprovisionSchema = z.object({
  bot_id: z.string().describe("Bot identifier to remove"),
})

export const BotDeprovisionTool: Tool = {
  name: "bot_deprovision",
  description: "Stop and remove a bot container from the Bot Server Droplet.",
  schema: deprovisionSchema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { bot_id } = deprovisionSchema.parse(params)
    const containerName = `bot-${bot_id}`
    const output = ssh(`docker rm -f ${containerName} 2>&1 || echo 'not found'`)
    return { ok: true, bot_id, output }
  },
}

// ─── bot_list ──────────────────────────────────────────────────────────────────

export const BotListTool: Tool = {
  name: "bot_list",
  description: "List all running bot containers on the Bot Server Droplet.",
  schema: z.object({}),
  async execute(_params: unknown, _ctx: ToolContext): Promise<unknown> {
    const output = ssh(
      `docker ps --filter 'name=bot-' --format '{{.Names}}\t{{.Status}}\t{{.ID}}' 2>&1`
    )
    const bots = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, status, id] = line.split("\t")
        return { name, status, id }
      })
    return { bots, count: bots.length }
  },
}

// ─── bot_logs ──────────────────────────────────────────────────────────────────

const logsSchema = z.object({
  bot_id: z.string().describe("Bot identifier"),
  lines: z.number().optional().default(50).describe("Number of log lines to return"),
})

export const BotLogsTool: Tool = {
  name: "bot_logs",
  description: "Get recent logs from a bot container on the Bot Server Droplet.",
  schema: logsSchema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { bot_id, lines } = logsSchema.parse(params)
    const containerName = `bot-${bot_id}`
    const output = ssh(`docker logs --tail ${lines} ${containerName} 2>&1`)
    return { bot_id, logs: output }
  },
}
