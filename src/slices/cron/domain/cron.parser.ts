import type { Job } from "./cron.types"

interface CronExpression {
  minute: number | null
  hour: number | null
  dom: number | null
  month: number | null
  dow: number | null
}

function parse(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/)
  const field = (p: string) => (p === "*" ? null : parseInt(p, 10))
  return {
    minute: field(parts[0] ?? "*"),
    hour:   field(parts[1] ?? "*"),
    dom:    field(parts[2] ?? "*"),
    month:  field(parts[3] ?? "*"),
    dow:    field(parts[4] ?? "*"),
  }
}

export function shouldRun(job: Job, now: Date): boolean {
  const cron = parse(job.schedule)
  return (
    (cron.minute === null || cron.minute === now.getMinutes()) &&
    (cron.hour   === null || cron.hour   === now.getHours())   &&
    (cron.dom    === null || cron.dom    === now.getDate())     &&
    (cron.month  === null || cron.month  === now.getMonth() + 1) &&
    (cron.dow    === null || cron.dow    === now.getDay())
  )
}
