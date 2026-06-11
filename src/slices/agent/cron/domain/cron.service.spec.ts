import { beforeEach, describe, expect, mock, test } from "bun:test"
import { CronService } from "./cron.service"
import type { ICronGateway } from "./cron.gateway"
import type { CronJob } from "./cron.types"
import { parseCron } from "../data/cron.parser"

const job = (over: Partial<CronJob> = {}): CronJob => ({
  id: "job-1",
  name: "test",
  schedule: "* * * * *",
  message: "ping",
  enabled: true,
  ...over,
})

const makeGateway = (initial: CronJob[] = []): { gateway: ICronGateway; saved: () => CronJob[] } => {
  let store = [...initial]
  const gateway: ICronGateway = {
    load: mock(async () => [...store]),
    save: mock(async (jobs: CronJob[]) => { store = [...jobs] }),
    parse: mock((schedule: string) => parseCron(schedule)),
  }
  return { gateway, saved: () => store }
}

describe("CronService.list", () => {
  test("returns whatever the gateway loads", async () => {
    const { gateway } = makeGateway([job(), job({ id: "job-2" })])
    const service = new CronService(gateway)

    const result = await service.list()

    expect(result.map(j => j.id)).toEqual(["job-1", "job-2"])
  })
})

describe("CronService.add", () => {
  test("appends to existing jobs and saves", async () => {
    const { gateway, saved } = makeGateway([job()])
    const service = new CronService(gateway)

    await service.add(job({ id: "job-2" }))

    expect(saved().map(j => j.id)).toEqual(["job-1", "job-2"])
    expect(gateway.save).toHaveBeenCalledTimes(1)
  })

  test("creates first job when store is empty", async () => {
    const { gateway, saved } = makeGateway([])
    const service = new CronService(gateway)

    await service.add(job())

    expect(saved()).toHaveLength(1)
  })
})

describe("CronService.remove", () => {
  test("removes the matching job by id", async () => {
    const { gateway, saved } = makeGateway([job(), job({ id: "job-2" })])
    const service = new CronService(gateway)

    await service.remove("job-1")

    expect(saved().map(j => j.id)).toEqual(["job-2"])
  })

  test("is a no-op (still saves) when id is unknown", async () => {
    const { gateway, saved } = makeGateway([job()])
    const service = new CronService(gateway)

    await service.remove("missing")

    expect(saved().map(j => j.id)).toEqual(["job-1"])
    expect(gateway.save).toHaveBeenCalledTimes(1)
  })
})

describe("CronService.updateLastRun", () => {
  test("sets lastRunAt on the matching job", async () => {
    const { gateway, saved } = makeGateway([job()])
    const service = new CronService(gateway)

    await service.updateLastRun("job-1", 1_700_000_000_000)

    expect(saved()[0]?.lastRunAt).toBe(1_700_000_000_000)
    expect(gateway.save).toHaveBeenCalledTimes(1)
  })

  test("does not save when id is unknown", async () => {
    const { gateway } = makeGateway([job()])
    const service = new CronService(gateway)

    await service.updateLastRun("missing", 123)

    expect(gateway.save).not.toHaveBeenCalled()
  })
})

describe("CronService.shouldRun", () => {
  let service: CronService

  beforeEach(() => {
    const { gateway } = makeGateway()
    service = new CronService(gateway)
  })

  test("'* * * * *' fires every minute", () => {
    expect(service.shouldRun(job({ schedule: "* * * * *" }), new Date(2026, 0, 1, 12, 34))).toBe(true)
  })

  test("'0 9 * * *' fires at 09:00 only", () => {
    const j = job({ schedule: "0 9 * * *" })
    expect(service.shouldRun(j, new Date(2026, 0, 1, 9, 0))).toBe(true)
    expect(service.shouldRun(j, new Date(2026, 0, 1, 9, 1))).toBe(false)
    expect(service.shouldRun(j, new Date(2026, 0, 1, 10, 0))).toBe(false)
  })

  test("day-of-month is checked", () => {
    const j = job({ schedule: "0 0 15 * *" })
    expect(service.shouldRun(j, new Date(2026, 0, 15, 0, 0))).toBe(true)
    expect(service.shouldRun(j, new Date(2026, 0, 16, 0, 0))).toBe(false)
  })

  test("month is 1-indexed (June = 6)", () => {
    const j = job({ schedule: "0 0 1 6 *" })
    expect(service.shouldRun(j, new Date(2026, 5, 1, 0, 0))).toBe(true)
    expect(service.shouldRun(j, new Date(2026, 4, 1, 0, 0))).toBe(false)
  })

  test("day-of-week matches getDay() (Sunday = 0, Monday = 1)", () => {
    const j = job({ schedule: "0 9 * * 1" })
    const monday = new Date(2026, 0, 5, 9, 0)
    const sunday = new Date(2026, 0, 4, 9, 0)
    expect(monday.getDay()).toBe(1)
    expect(service.shouldRun(j, monday)).toBe(true)
    expect(service.shouldRun(j, sunday)).toBe(false)
  })

  describe("timezone-aware scheduling (tz field)", () => {
    // 2026-01-01 07:00 UTC = 09:00 Europe/Kyiv (UTC+2 in winter)
    const utc0700 = new Date("2026-01-01T07:00:00Z")

    test("'0 9 * * *' with tz=Europe/Kyiv fires at 09:00 Kyiv time (07:00 UTC)", () => {
      const j = job({ schedule: "0 9 * * *", tz: "Europe/Kyiv" })
      expect(service.shouldRun(j, utc0700)).toBe(true)
    })

    test("'0 9 * * *' without tz does NOT fire at 07:00 UTC when server is UTC", () => {
      // Without tz the job uses server local time; 07:00 UTC ≠ 09:00
      const j = job({ schedule: "0 9 * * *" })
      // This test is only meaningful when the test runner is in UTC (TZ=UTC).
      // It documents that local-time and tz-aware paths differ.
      const serverHour = utc0700.getHours()
      expect(service.shouldRun(j, utc0700)).toBe(serverHour === 9)
    })

    test("'0 9 * * *' with tz=Europe/Kyiv does NOT fire at 08:00 UTC (10:00 Kyiv)", () => {
      const utc0800 = new Date("2026-01-01T08:00:00Z")
      const j = job({ schedule: "0 9 * * *", tz: "Europe/Kyiv" })
      expect(service.shouldRun(j, utc0800)).toBe(false)
    })

    test("'0 0 * * *' midnight in America/New_York fires at 05:00 UTC (UTC-5 in winter)", () => {
      const utc0500 = new Date("2026-01-01T05:00:00Z")
      const j = job({ schedule: "0 0 * * *", tz: "America/New_York" })
      expect(service.shouldRun(j, utc0500)).toBe(true)
    })
  })
})
