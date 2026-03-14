export interface CronJob {
  id: string
  name: string
  schedule: string  // cron expression "* * * * *"
  tz?: string
  message: string   // agent message payload
  to?: string       // chat id to deliver response (e.g. telegram user id)
  channel?: string  // channel name (e.g. "telegram")
  enabled: boolean
  lastRunAt?: number
}
