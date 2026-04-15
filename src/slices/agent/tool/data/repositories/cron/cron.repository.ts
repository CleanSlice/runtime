import { z } from "zod"
import { randomUUID } from "crypto"
import type { ToolContext } from "../../../domain/tool.types"

const cronDir = (ctx: ToolContext) => `${ctx.agentDir}/data`
const cronPath = (ctx: ToolContext) => `${cronDir(ctx)}/cron.json`

type CronJob = {
  id: string
  name: string
  schedule: string
  message: string
  to?: string
  channel?: string
  enabled: boolean
  lastRunAt?: number
}

async function loadJobs(ctx: ToolContext): Promise<CronJob[]> {
  try {
    const text = await Bun.file(cronPath(ctx)).text()
    return JSON.parse(text)
  } catch {
    return []
  }
}

async function saveJobs(jobs: CronJob[], ctx: ToolContext): Promise<void> {
  const { mkdirSync } = await import("fs")
  mkdirSync(cronDir(ctx), { recursive: true })
  await Bun.write(cronPath(ctx), JSON.stringify(jobs, null, 2))
}

export const CronListRepository = {
  name: "cron_list",
  description: "List all scheduled cron jobs",
  schema: z.object({}),
  async execute(_params: unknown, ctx: ToolContext) {
    const jobs = await loadJobs(ctx)
    return jobs.map(j => ({ id: j.id, name: j.name, schedule: j.schedule, enabled: j.enabled }))
  },
}

export const CronAddRepository = {
  name: "cron_add",
  description: "Add a scheduled job. For recurring tasks use schedule (cron expression). For one-time reminders use delayMinutes or runAt (unix timestamp ms). IMPORTANT: the message field must contain all concrete values (real emails, real text) — never use placeholders like test@example.com.",
  adminOnly: true,
  schema: z.object({
    name: z.string(),
    schedule: z.string().optional().default("* * * * *").describe("Cron expression for recurring tasks"),
    message: z.string().describe("Full self-contained instruction with ALL real values from the current conversation. Extract concrete data — real email addresses, real names, real text. Example: if user said 'send same email in 1 min' after sending to john@gmail.com with body 'hello' — write 'Send email to john@gmail.com with subject hello and body hello'. NEVER use placeholders like test@example.com or example text."),
    to: z.string().optional().describe("Chat ID to deliver response"),
    channel: z.string().optional().default("telegram"),
    runOnce: z.boolean().optional().describe("If true, delete after first run"),
    delayMinutes: z.number().optional().describe("Run once after N minutes from now"),
    runAt: z.number().optional().describe("Run once at this unix timestamp (ms)"),
  }),
  async execute(params: unknown, ctx: ToolContext) {
    const p = params as {
      name: string; schedule?: string; message: string; to?: string; channel?: string;
      runOnce?: boolean; delayMinutes?: number; runAt?: number
    }
    const jobs = await loadJobs(ctx)

    const runAt = p.runAt ?? (p.delayMinutes ? Date.now() + p.delayMinutes * 60_000 : undefined)

    const job: CronJob = {
      id: randomUUID(),
      name: p.name,
      schedule: p.schedule ?? "* * * * *",
      message: p.message,
      to: p.to ?? ctx.from,
      channel: p.channel ?? ctx.channel ?? "telegram",
      enabled: true,
      runOnce: p.runOnce || !!runAt,
      ...(runAt ? { runAt } : {}),
    }
    jobs.push(job)
    await saveJobs(jobs, ctx)
    return { ok: true, id: job.id, name: job.name, runAt, delayMinutes: p.delayMinutes }
  },
}

export const CronRemoveRepository = {
  name: "cron_remove",
  description: "Remove a cron job by id or name",
  adminOnly: true,
  schema: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }),
  async execute(params: unknown, ctx: ToolContext) {
    const p = params as { id?: string; name?: string }
    const jobs = await loadJobs(ctx)
    const before = jobs.length
    const filtered = jobs.filter(j => j.id !== p.id && j.name !== p.name)
    await saveJobs(filtered, ctx)
    return { removed: before - filtered.length }
  },
}

export const CronDisableRepository = {
  name: "cron_disable",
  description: "Disable a cron job by id or name (keeps it but stops it from running)",
  adminOnly: true,
  schema: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }),
  async execute(params: unknown, ctx: ToolContext) {
    const p = params as { id?: string; name?: string }
    const jobs = await loadJobs(ctx)
    for (const j of jobs) {
      if (j.id === p.id || j.name === p.name) j.enabled = false
    }
    await saveJobs(jobs, ctx)
    return { ok: true }
  },
}
