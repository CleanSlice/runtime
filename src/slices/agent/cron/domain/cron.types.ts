export interface CronJob {
  id: string
  name: string
  schedule: string  // cron expression "* * * * *"
  tz?: string
  message: string   // agent message payload
  to?: string       // chat id to deliver response (e.g. telegram user id)
  channel?: string  // channel name (e.g. "telegram")
  /**
   * The job is addressed to the administrator who made it (CLEAN-236): when
   * it fires, the turn is theirs and an administrator's. A console Admin's
   * conversation is under their own id, which no admin list names, so
   * without this their own reminder would come back as a visitor's turn.
   * Never set on a job addressed to somebody else.
   */
  admin?: boolean
  enabled: boolean
  lastRunAt?: number
  runOnce?: boolean      // if true, delete job after first run
  runAt?: number         // unix timestamp ms — run once at specific time
}
