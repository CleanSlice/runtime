import { describe, expect, test } from "bun:test"
import { SessionService } from "./session.service"
import type { ISessionGateway } from "./session.gateway"
import type { SessionActivity } from "./activity"
import type { Event } from "../../../setup/event"

function noopGateway(): ISessionGateway {
  return {
    append: async () => {},
    read: async () => [],
    rewrite: async () => {},
  }
}

function evt(over: Partial<Event>): Event {
  return { id: "e1", type: "user", ts: 1000, data: { text: "hi" }, ...over }
}

function harness() {
  const reports: SessionActivity[] = []
  const svc = new SessionService(noopGateway())
  svc.setActivityReporter({ report: (a) => reports.push(a) })
  return { svc, reports }
}

describe("SessionService activity emit", () => {
  test("emits for a real user turn", async () => {
    const { svc, reports } = harness()
    await svc.append("bridle:admin", evt({ type: "user", data: { text: "hello there" } }))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      sessionKey: "bridle:admin",
      channel: "bridle",
      externalUserId: "admin",
      role: "user",
      preview: "hello there",
    })
  })

  test("emits for an assistant turn", async () => {
    const { svc, reports } = harness()
    await svc.append("telegram:12345", evt({ type: "assistant", data: { text: "hi" } }))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ channel: "telegram", externalUserId: "12345", role: "assistant" })
  })

  test("skips tool_call / tool_result / summary events", async () => {
    const { svc, reports } = harness()
    await svc.append("bridle:admin", evt({ type: "tool_call", data: { name: "x" } }))
    await svc.append("bridle:admin", evt({ type: "tool_result", data: { result: "y" } }))
    await svc.append("bridle:admin", evt({ type: "summary", data: { text: "z" } }))
    expect(reports).toHaveLength(0)
  })

  test("skips internal channel (cron/heartbeat)", async () => {
    const { svc, reports } = harness()
    await svc.append("internal:heartbeat", evt({ type: "assistant", data: { text: "HEARTBEAT_OK" } }))
    expect(reports).toHaveLength(0)
  })

  test("skips synthetic transient events (continuation prompts / partials)", async () => {
    const { svc, reports } = harness()
    await svc.append("bridle:admin", evt({ type: "user", data: { text: "continue", transient: true } }))
    await svc.append("bridle:admin", evt({ type: "assistant", data: { text: "part", transient: true } }))
    expect(reports).toHaveLength(0)
  })

  test("does nothing when no reporter is wired", async () => {
    const svc = new SessionService(noopGateway())
    await expect(svc.append("bridle:admin", evt({}))).resolves.toBeUndefined()
  })
})
