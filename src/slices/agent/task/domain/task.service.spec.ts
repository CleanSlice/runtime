import { describe, expect, test } from "bun:test"
import { TaskManager } from "./task.service"
import { TaskGateway } from "../data/task.gateway"

const never = () => new Promise<void>(() => {})
const tick = () => new Promise(r => setTimeout(r, 0))

describe("TaskManager in-flight and parent/child (CLEAN-150)", () => {
  test("inFlight is true while a task of the session runs and false once it ends", async () => {
    const tasks = new TaskManager(new TaskGateway())
    expect(tasks.inFlight("s1")).toBe(false)
    const t = tasks.start("s1", "work", never)
    expect(tasks.inFlight("s1")).toBe(true)
    expect(tasks.inFlight("s2")).toBe(false)
    tasks.cancel(t.id)
    expect(tasks.inFlight("s1")).toBe(false)
  })

  test("a finished task no longer counts as in flight", async () => {
    const tasks = new TaskManager(new TaskGateway())
    tasks.start("s1", "quick", async () => {})
    await tick()
    expect(tasks.inFlight("s1")).toBe(false)
  })

  test("children carry parentTaskId and are listed under the parent", () => {
    const tasks = new TaskManager(new TaskGateway())
    const parent = tasks.start("s1", "parent", never)
    const a = tasks.start("s1", "child a", never, { internal: true, parentTaskId: parent.id })
    const b = tasks.start("s1", "child b", never, { internal: true, parentTaskId: parent.id })
    tasks.start("s1", "unrelated", never)

    expect(a.parentTaskId).toBe(parent.id)
    expect(tasks.getChildren(parent.id).map(t => t.id).sort()).toEqual([a.id, b.id].sort())
    expect(tasks.getChildren("nope")).toEqual([])
  })
})
