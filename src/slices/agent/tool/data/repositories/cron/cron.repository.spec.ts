import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronAddRepository } from "./cron.repository"
import type { CronJob } from "../../../../cron/domain/cron.types"
import type { ToolContext } from "../../../domain/tool.types"

/**
 * CLEAN-236. A scheduled job addressed to a person on a channel is that
 * person's turn when it fires. An administrator's used to be an
 * administrator's by its address: every Owner and Admin of the console was
 * `admin`, an id the runtime keeps in its admin list. A console Admin has
 * their own id now, so the job records what the id no longer says.
 */
let agentDir: string
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "cron-spec-"))
})
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
})

const ctx = (over: Partial<ToolContext>): ToolContext => ({
  sessionId: "s",
  agentDir,
  send: async () => {},
  ...over,
})

async function added(params: Record<string, unknown>, context: ToolContext): Promise<CronJob> {
  await CronAddRepository.execute({ name: "reminder", message: "Check the queue", delayMinutes: 5, ...params }, context)
  const jobs = JSON.parse(readFileSync(join(agentDir, "data", "cron.json"), "utf8")) as CronJob[]
  return jobs.at(-1)!
}

describe("cron_add — whose turn the job will be", () => {
  test("an administrator's job to their own conversation stays an administrator's", async () => {
    const job = await added({}, ctx({ from: "user-a", channel: "bridle", isAdmin: true }))

    expect(job).toMatchObject({ to: "user-a", channel: "bridle", admin: true })
  })

  test("a job addressed to somebody else is that person's turn, and no administrator's", async () => {
    const job = await added({ to: "share-visitor-7" }, ctx({ from: "user-a", channel: "bridle", isAdmin: true }))

    expect(job.to).toBe("share-visitor-7")
    expect("admin" in job).toBe(false)
  })

  test("nor is one sent to the same id on another channel, where it is another person's", async () => {
    const job = await added({ channel: "telegram" }, ctx({ from: "user-a", channel: "bridle", isAdmin: true }))

    expect(job).toMatchObject({ to: "user-a", channel: "telegram" })
    expect("admin" in job).toBe(false)
  })

  test("a turn that is not an administrator's records none", async () => {
    for (const isAdmin of [false, undefined]) {
      const job = await added({}, ctx({ from: "user-u", channel: "bridle", ...(isAdmin === undefined ? {} : { isAdmin }) }))
      expect("admin" in job).toBe(false)
    }
  })

  test("the model cannot ask for it", async () => {
    const job = await added({ admin: true }, ctx({ from: "user-u", channel: "bridle", isAdmin: false }))

    expect("admin" in job).toBe(false)
  })

  test("a turn with no sender has nobody to address: the agent's own job stays the agent's own", async () => {
    const job = await added({}, ctx({ channel: "internal", isAdmin: true }))

    expect("admin" in job).toBe(false)
  })
})
