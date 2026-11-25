import { describe, expect, test } from "bun:test"
import { BridleRepository } from "./bridle.repository"

/**
 * `tool_state` on the agent socket (CLEAN-245): the hub hears the latest
 * state, not every step of a burst, and hears it again whenever it learns
 * the agent is there.
 */

class FakeSocket {
  connected = true
  sent: Array<{ event: string; data: unknown }> = []
  emit(event: string, data: unknown) {
    this.sent.push({ event, data })
  }
}

function make() {
  const repository = new BridleRepository("http://hub.test")
  const socket = new FakeSocket()
  ;(repository as unknown as { socket: FakeSocket }).socket = socket
  return { repository, socket }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const state = (phase: string) => ({ phase, servers: [] })

describe("reportToolState", () => {
  test("a burst of changes is one event carrying the last of them", async () => {
    const { repository, socket } = make()

    repository.reportToolState(state("connecting"))
    repository.reportToolState(state("limited"))
    repository.reportToolState(state("ready"))
    expect(socket.sent).toEqual([])

    await wait(560)
    expect(socket.sent).toEqual([{ event: "tool_state", data: state("ready") }])
  })

  test("nothing is sent while the socket is down; the next register carries it", async () => {
    const { repository, socket } = make()
    socket.connected = false

    repository.reportToolState(state("limited"))
    await wait(560)
    expect(socket.sent).toEqual([])

    socket.connected = true
    ;(repository as unknown as { register(): void }).register()
    expect(socket.sent).toEqual([
      { event: "register", data: {} },
      { event: "tool_state", data: state("limited") },
    ])
  })

  test("a register before anything was reported sends only the register", () => {
    const { repository, socket } = make()
    ;(repository as unknown as { register(): void }).register()
    expect(socket.sent).toEqual([{ event: "register", data: {} }])
  })
})
