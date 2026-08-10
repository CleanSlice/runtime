import { describe, expect, mock, test } from "bun:test"
import { join } from "path"
import { HeartbeatService, hasActionableTasks } from "./heartbeat.service"
import type { IHeartbeatGateway } from "./heartbeat.gateway"

const TEMPLATE = `# HEARTBEAT.md

_Add periodic tasks here. Your assistant checks this every 30 minutes._

## Tasks

(empty — add reminders or periodic checks here)
`

/** Mutable fake gateway — lets tests flip file state between ticks. */
const makeGateway = (initial: { exists: boolean; content: string }) => {
  const state = { ...initial }
  const gateway: IHeartbeatGateway = {
    exists: mock(() => state.exists),
    load: mock(async () => state.content),
  }
  return { gateway, state }
}

describe("hasActionableTasks", () => {
  test("empty and whitespace-only content is not actionable", () => {
    expect(hasActionableTasks("")).toBe(false)
    expect(hasActionableTasks("   \n\n\t  ")).toBe(false)
  })

  test("headings-only content is not actionable", () => {
    expect(hasActionableTasks("# HEARTBEAT.md\n\n## Tasks\n")).toBe(false)
  })

  test("emphasis-only template lines are not actionable", () => {
    expect(hasActionableTasks("_Add periodic tasks here. Your assistant checks this every 30 minutes._")).toBe(false)
    expect(hasActionableTasks("*guidance line*")).toBe(false)
  })

  test("the shipped placeholder line is not actionable", () => {
    expect(hasActionableTasks("(empty — add reminders or periodic checks here)")).toBe(false)
  })

  test("HTML comments are not actionable", () => {
    expect(hasActionableTasks("<!-- keep this file -->")).toBe(false)
    expect(hasActionableTasks("<!--\nmulti\nline\n-->")).toBe(false)
  })

  test("the unmodified shipped template is not actionable", () => {
    expect(hasActionableTasks(TEMPLATE)).toBe(false)
  })

  test("the template file currently shipped in .agent.example stays inert", async () => {
    // Guards the template itself: rewording it must never make it "actionable".
    const shipped = await Bun.file(join(import.meta.dir, "../../../../../.agent.example/HEARTBEAT.md")).text()
    expect(hasActionableTasks(shipped)).toBe(false)
  })

  test("a task bullet makes content actionable", () => {
    expect(hasActionableTasks(`${TEMPLATE}\n- check inbox daily and report`)).toBe(true)
    expect(hasActionableTasks("- remind me on Monday about the demo")).toBe(true)
  })

  test("bare prose (no markdown structure) is actionable — err toward running", () => {
    expect(hasActionableTasks("Проверяй почту раз в день и пиши мне.")).toBe(true)
  })
})

describe("HeartbeatService.shouldRun", () => {
  test("false when the file is absent", async () => {
    const { gateway } = makeGateway({ exists: false, content: "" })
    expect(await new HeartbeatService(gateway).shouldRun()).toBe(false)
  })

  test("false when the file exists but has no actionable tasks", async () => {
    const { gateway } = makeGateway({ exists: true, content: TEMPLATE })
    expect(await new HeartbeatService(gateway).shouldRun()).toBe(false)
  })

  test("true when the file has a task", async () => {
    const { gateway } = makeGateway({ exists: true, content: "- ping me at noon" })
    expect(await new HeartbeatService(gateway).shouldRun()).toBe(true)
  })
})

describe("HeartbeatService.tick", () => {
  test("does not invoke the handler for an inert file", async () => {
    const { gateway } = makeGateway({ exists: true, content: TEMPLATE })
    const handler = mock(async () => {})

    await new HeartbeatService(gateway).tick("prompt", handler)

    expect(handler).not.toHaveBeenCalled()
  })

  test("invokes the handler with the prompt when tasks exist", async () => {
    const { gateway } = makeGateway({ exists: true, content: "- daily check" })
    const handler = mock(async () => {})

    await new HeartbeatService(gateway).tick("the-prompt", handler)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith("the-prompt")
  })

  test("re-evaluates every tick: task added mid-flight activates the next tick", async () => {
    const { gateway, state } = makeGateway({ exists: true, content: TEMPLATE })
    const handler = mock(async () => {})
    const service = new HeartbeatService(gateway)

    await service.tick("prompt", handler)
    expect(handler).not.toHaveBeenCalled()

    state.content = `${TEMPLATE}\n- new task added by operator`
    await service.tick("prompt", handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test("re-evaluates every tick: file deleted mid-flight stops the next tick", async () => {
    const { gateway, state } = makeGateway({ exists: true, content: "- active task" })
    const handler = mock(async () => {})
    const service = new HeartbeatService(gateway)

    await service.tick("prompt", handler)
    expect(handler).toHaveBeenCalledTimes(1)

    state.exists = false
    await service.tick("prompt", handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
