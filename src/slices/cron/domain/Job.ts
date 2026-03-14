export interface Job {
  id: string
  name: string
  schedule: string  // cron expression "* * * * *"
  tz?: string
  message: string   // agent message payload
  enabled: boolean
  lastRunAt?: number
}
