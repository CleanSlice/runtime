import type { ICronGateway } from "./cron.gateway"
import type { CronJob } from "./cron.types"

// Extract wall-clock fields in a specific IANA timezone using Intl.
// Falls back to server local time if tz is undefined.
function timeParts(date: Date, tz?: string): { minute: number; hour: number; dom: number; month: number; dow: number } {
  if (!tz) {
    return {
      minute: date.getMinutes(),
      hour:   date.getHours(),
      dom:    date.getDate(),
      month:  date.getMonth() + 1,
      dow:    date.getDay(),
    }
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]))
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return {
    minute: parseInt(parts.minute ?? "0"),
    // Intl may return "24" for midnight in hour12:false mode on some runtimes
    hour:   parseInt(parts.hour ?? "0") % 24,
    dom:    parseInt(parts.day ?? "1"),
    month:  parseInt(parts.month ?? "1"),
    dow:    WEEKDAYS.indexOf(parts.weekday ?? ""),
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

  // Evaluates the cron expression against the job's timezone (job.tz) if set,
  // otherwise falls back to the server's local time. This ensures "0 9 * * *"
  // fires at 09:00 in the user's timezone, not the server's.
  shouldRun(job: CronJob, now: Date): boolean {
    const cron = this.gateway.parse(job.schedule)
    const dt = timeParts(now, job.tz)
    return (
      (cron.minute === null || cron.minute === dt.minute) &&
      (cron.hour   === null || cron.hour   === dt.hour)   &&
      (cron.dom    === null || cron.dom    === dt.dom)     &&
      (cron.month  === null || cron.month  === dt.month)   &&
      (cron.dow    === null || cron.dow    === dt.dow)
    )
  }
}
