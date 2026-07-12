import { z } from "zod"
import { randomUUID } from "crypto"
import type { ToolContext } from "../../../domain/tool.types"
import type { CronJob } from "../../../../cron/domain/cron.types"
import { parseCron } from "../../../../cron/data/cron.parser"

const cronDir = (ctx: ToolContext) => `${ctx.agentDir}/data`
const cronPath = (ctx: ToolContext) => `${cronDir(ctx)}/cron.json`

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
  description:
    "Add a scheduled job. For recurring tasks use schedule (standard cron syntax: numbers, ranges 1-5, lists 0,30, steps */10). " +
    "The schedule is evaluated in UTC unless tz is set — when the user names a wall-clock time ('every day at 9'), ALWAYS pass their IANA timezone (e.g. 'Europe/Kyiv') in tz. " +
    "For one-time reminders use delayMinutes or runAt (unix timestamp ms). " +
    "IMPORTANT: the message field must contain all concrete values (real emails, real text) — never use placeholders like test@example.com.",
  adminOnly: true,
  schema: z.object({
    name: z.string(),
    schedule: z.string().optional().default("* * * * *").describe("Cron expression for recurring tasks. Supports *, numbers, ranges (1-5), lists (0,30), steps (*/10)."),
    tz: z.string().optional().describe("IANA timezone the schedule's wall-clock times refer to, e.g. 'Europe/Kyiv'. Omit for UTC."),
    message: z.string().describe("Full self-contained instruction with ALL real values from the current conversation. Extract concrete data — real email addresses, real names, real text. Example: if user said 'send same email in 1 min' after sending to john@gmail.com with body 'hello' — write 'Send email to john@gmail.com with subject hello and body hello'. NEVER use placeholders like test@example.com or example text."),
    to: z.string().optional().describe("Chat ID to deliver response"),
    channel: z.string().optional().default("telegram"),
    runOnce: z.boolean().optional().describe("If true, delete after first run"),
    delayMinutes: z.number().optional().describe("Run once after N minutes from now"),
    runAt: z.number().optional().describe("Run once at this unix timestamp (ms)"),
  }),
  async execute(params: unknown, ctx: ToolContext) {
    const p = params as {
      name: string; schedule?: string; tz?: string; message: string; to?: string; channel?: string;
      runOnce?: boolean; delayMinutes?: number; runAt?: number
    }

    const runAt = p.runAt ?? (p.delayMinutes ? Date.now() + p.delayMinutes * 60_000 : undefined)
    const schedule = p.schedule ?? "* * * * *"

    // Validate at creation time — a bad expression must fail HERE, visibly,
    // not get persisted as a job that silently never fires.
    if (!runAt) {
      try {
        parseCron(schedule)
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
    if (p.tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: p.tz })
      } catch {
        return { error: `Unknown timezone "${p.tz}" — pass an IANA name like "Europe/Kyiv"` }
      }
    }

    const jobs = await loadJobs(ctx)

    const job: CronJob = {
      id: randomUUID(),
      name: p.name,
      schedule,
      ...(p.tz ? { tz: p.tz } : {}),
      message: p.message,
      to: p.to ?? ctx.from,
      channel: p.channel ?? ctx.channel ?? "telegram",
      enabled: true,
      runOnce: p.runOnce || !!runAt,
      ...(runAt ? { runAt } : {}),
    }
    jobs.push(job)
    await saveJobs(jobs, ctx)
    return { ok: true, id: job.id, name: job.name, schedule, tz: p.tz, runAt, delayMinutes: p.delayMinutes }
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
