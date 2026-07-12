import type { ICronGateway } from "./cron.gateway"
import type { CronJob } from "./cron.types"

interface WallClock {
  minute: number
  hour: number
  dom: number
  month: number
  dow: number
}

const DOW_NAMES: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

// Wall-clock components of `now` in the job's timezone. Without `tz` the
// container's local time is used — in k8s that's UTC, which is why cron_add
// tells the agent to always pass the user's IANA timezone for wall-clock
// schedules ("every day at 9" means the USER's 9am, not UTC's).
function wallClock(now: Date, tz?: string): WallClock {
  const local = (): WallClock => ({
    minute: now.getMinutes(),
    hour: now.getHours(),
    dom: now.getDate(),
    month: now.getMonth() + 1,
    dow: now.getDay(),
  })
  if (!tz) return local()
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hourCycle: "h23",
    }).formatToParts(now)
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? ""
    return {
      minute: Number(get("minute")),
      hour: Number(get("hour")),
      dom: Number(get("day")),
      month: Number(get("month")),
      dow: DOW_NAMES[get("weekday")] ?? now.getDay(),
    }
  } catch {
    // Unknown timezone — cron_add validates tz, so this only happens for
    // hand-edited cron.json. Fall back to local rather than never firing.
    return local()
  }
}

export class CronService {
  constructor(private gateway: ICronGateway) {}

  async list(): Promise<CronJob[]> {
    return this.gateway.load()
  }

  async add(job: CronJob): Promise<void> {
    const jobs = await this.gateway.load()
    jobs.push(job)
    await this.gateway.save(jobs)
  }

  async remove(id: string): Promise<void> {
    const jobs = await this.gateway.load()
    await this.gateway.save(jobs.filter(j => j.id !== id))
  }

  async updateLastRun(id: string, ts: number): Promise<void> {
    const jobs = await this.gateway.load()
    const job = jobs.find(j => j.id === id)
    if (job) {
      job.lastRunAt = ts
      await this.gateway.save(jobs)
    }
  }

  shouldRun(job: CronJob, now: Date): boolean {
    const cron = this.gateway.parse(job.schedule)
    const t = wallClock(now, job.tz)
    const match = (allowed: number[] | null, value: number): boolean =>
      allowed === null || allowed.includes(value)
    return (
      match(cron.minute, t.minute) &&
      match(cron.hour, t.hour) &&
      match(cron.dom, t.dom) &&
      match(cron.month, t.month) &&
      match(cron.dow, t.dow)
    )
  }
}
