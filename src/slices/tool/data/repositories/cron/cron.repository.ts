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
  description: "Add a new cron job. Schedule is a standard cron expression (e.g. '0 9 * * *' = 9am daily).",
  schema: z.object({
    name: z.string(),
    schedule: z.string(),
    message: z.string().describe("What the agent should do when this job fires"),
    to: z.string().optional().describe("Telegram chat ID to deliver response"),
    channel: z.string().optional().default("telegram"),
  }),
  async execute(params: unknown, ctx: ToolContext) {
    const p = params as { name: string; schedule: string; message: string; to?: string; channel?: string }
    const jobs = await loadJobs(ctx)
    const job: CronJob = {
      id: randomUUID(),
      name: p.name,
      schedule: p.schedule,
      message: p.message,
      to: p.to,
      channel: p.channel ?? "telegram",
      enabled: true,
    }
    jobs.push(job)
    await saveJobs(jobs, ctx)
    return { ok: true, id: job.id, name: job.name }
  },
}

export const CronRemoveRepository = {
  name: "cron_remove",
  description: "Remove a cron job by id or name",
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
