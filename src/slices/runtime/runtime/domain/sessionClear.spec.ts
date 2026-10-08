import { describe, expect, test } from "bun:test"
import { TaskGateway } from "../../../agent/task/data/task.gateway"
import { clearBridleSession, type ISessionClearDeps } from "./sessionClear"

function recorder() {
  const calls: string[] = []
  const deps: ISessionClearDeps = {
    tasks: {
      cancelAll: (sessionId) => {
        calls.push(`cancel ${sessionId}`)
        return 2
      },
    },
    router: { clear: (sessionId) => void calls.push(`route ${sessionId}`) },
    session: { clear: (channelId, userId) => void calls.push(`clear ${channelId} ${userId}`) },
  }
  return { deps, calls }
}

describe("clearBridleSession", () => {
  test("cancels what is running for the conversation before forgetting it", () => {
    const { deps, calls } = recorder()

    clearBridleSession(deps, "admin")

    expect(calls).toEqual(["cancel bridle:admin", "route bridle:admin", "clear bridle admin"])
  })

  test("addresses a share visitor's conversation by the visitor's channel", () => {
    const { deps, calls } = recorder()

    clearBridleSession(deps, "share-ab12")

    expect(calls).toEqual(["cancel bridle:share-ab12", "route bridle:share-ab12", "clear bridle share-ab12"])
  })

  test("says how many tasks it stopped", () => {
    const { deps } = recorder()

    expect(clearBridleSession(deps, "admin")).toBe(2)
  })
})

describe("clearBridleSession with the real task gateway", () => {
  const noRouter = { clear: () => {} }
  const noSession = { clear: () => {} }

  // A turn that never finishes on its own — what "still answering" looks like.
  const forever = () => new Promise<void>(() => {})

  test("aborts the running turn of that conversation and no other", () => {
    const tasks = new TaskGateway()
    const mine = tasks.start("bridle:admin", "answering", forever)
    const visitor = tasks.start("bridle:share-ab12", "answering", forever)

    const cancelled = clearBridleSession({ tasks, router: noRouter, session: noSession }, "admin")

    expect(cancelled).toBe(1)
    expect(mine.controller.signal.aborted).toBe(true)
    expect(mine.status).toBe("cancelled")
    expect(visitor.controller.signal.aborted).toBe(false)
    expect(visitor.status).toBe("running")
  })

  test("does nothing, quietly, when the conversation is idle", () => {
    const tasks = new TaskGateway()

    expect(clearBridleSession({ tasks, router: noRouter, session: noSession }, "admin")).toBe(0)
  })
})
