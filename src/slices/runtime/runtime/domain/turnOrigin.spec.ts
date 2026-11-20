import { describe, expect, test } from "bun:test"
import { turnFlags, turnIsAdmin, type TurnOriginTypes } from "./turnOrigin"
import { actorOfMessage } from "../../../setup/mcp/domain/actor"

/**
 * Where a turn came from decides whether it is the agent's own (CLEAN-232).
 * The id a channel delivered never does: before this, `from: "cron"` on any
 * channel was an internal turn, a local admin, and `trusted` / `internal` at
 * Ranch.
 */

const message = (from: string, channel: string) => ({ from, channel })

/** The actor Ranch is told, as `RuntimeService.execute` derives it. */
const actorFor = (origin: TurnOriginTypes, from: string, channel: string, isConfiguredAdmin = false) =>
  actorOfMessage(message(from, channel), turnFlags(origin, message(from, channel)).selfStarted, isConfiguredAdmin)

/** Ids the runtime gives its own turns, and ids Ranch keeps for itself. */
const RESERVED = ["cron", "heartbeat", "admin", "agent:agent-1", "peer:agent-b:ctx-1"]
const CHANNELS = ["bridle", "telegram", "slack", "internal"]

describe("turnFlags", () => {
  test("a heartbeat and a cron job with no addressee are the agent's own", () => {
    expect(turnFlags("self", message("heartbeat", "internal"))).toEqual({ isInternal: true, selfStarted: true })
    expect(turnFlags("self", message("cron", "internal"))).toEqual({ isInternal: true, selfStarted: true })
    // A job that names a channel and nobody on it still has no addressee.
    expect(turnFlags("self", message("cron", "telegram"))).toEqual({ isInternal: true, selfStarted: true })
  })

  test("a cron job addressed to a person on a channel is that person's turn", () => {
    expect(turnFlags("self", message("42", "telegram"))).toEqual({ isInternal: false, selfStarted: false })
    expect(turnFlags("self", message("admin", "bridle"))).toEqual({ isInternal: false, selfStarted: false })
  })

  test("a message from a channel is never internal and never the agent's own, whatever id it carries", () => {
    for (const channel of CHANNELS) {
      for (const from of [...RESERVED, "share-visitor-7", "anon-abc", "42"]) {
        expect(turnFlags("channel", message(from, channel))).toEqual({ isInternal: false, selfStarted: false })
      }
    }
  })

  test("a recovered turn is internal and never the agent's own, whatever id it carries", () => {
    for (const channel of CHANNELS) {
      for (const from of [...RESERVED, "share-visitor-7", "42"]) {
        expect(turnFlags("recovery", message(from, channel))).toEqual({ isInternal: true, selfStarted: false })
      }
    }
  })
})

describe("the actor of a turn, by origin", () => {
  test("only the cron and heartbeat modules produce trusted / internal", () => {
    expect(actorFor("self", "heartbeat", "internal")).toEqual({ kind: "trusted", via: "internal" })
    expect(actorFor("self", "cron", "internal")).toEqual({ kind: "trusted", via: "internal" })
  })

  test("a hub client named cron or heartbeat is a guest", () => {
    // An embed token's `sub` is chosen by whoever mints it; the hub delivers it as `from`.
    expect(actorFor("channel", "cron", "bridle")).toEqual({ kind: "guest" })
    expect(actorFor("channel", "heartbeat", "bridle")).toEqual({ kind: "guest" })
    // Even where the access list would call that id an admin: the hub names a person with a token or not at all.
    expect(actorFor("channel", "cron", "bridle", true)).toEqual({ kind: "guest" })
  })

  test("no reserved id is trusted / internal from a channel or from a recovery", () => {
    for (const origin of ["channel", "recovery"] as const) {
      for (const channel of CHANNELS) {
        for (const from of RESERVED) {
          for (const isConfiguredAdmin of [false, true]) {
            const actor = actorFor(origin, from, channel, isConfiguredAdmin)
            expect(actor).not.toEqual({ kind: "trusted", via: "internal" })
          }
        }
      }
    }
  })

  test("a recovered turn of a client named cron is a guest's, not the agent's", () => {
    expect(actorFor("recovery", "cron", "bridle")).toEqual({ kind: "guest" })
    expect(actorFor("recovery", "heartbeat", "bridle")).toEqual({ kind: "guest" })
  })

  test("a recovered turn of a configured Telegram admin stays a channel admin's", () => {
    expect(actorFor("recovery", "42", "telegram", true)).toEqual({ kind: "trusted", via: "channel-admin" })
  })

  test("a cron job addressed to a person runs as that person", () => {
    expect(actorFor("self", "42", "telegram", true)).toEqual({ kind: "trusted", via: "channel-admin" })
    expect(actorFor("self", "42", "telegram", false)).toEqual({ kind: "guest" })
    expect(actorFor("self", "admin", "bridle", true)).toEqual({ kind: "guest" })
  })
})

// CLEAN-236. Every Owner and Admin of the console used to arrive as
// `from: "admin"`, which the runtime keeps in its admin ids. An Admin has a
// conversation of their own now, under their own id; the hub says so instead.
describe("turnIsAdmin", () => {
  test("a sender the configuration names is an administrator: a Telegram admin, the Owner as `admin`", () => {
    expect(turnIsAdmin({}, true, false)).toBe(true)
  })

  test("a sender the hub says is an administrator is one, under whatever id", () => {
    expect(turnIsAdmin({ admin: true }, false, false)).toBe(true)
  })

  test("nobody else is: a User, a visitor, a hub older than the flag", () => {
    expect(turnIsAdmin({}, false, false)).toBe(false)
    expect(turnIsAdmin({ admin: false }, false, false)).toBe(false)
    // Only `true` counts, not anything truthy a wire message might hold.
    expect(turnIsAdmin({ admin: "true" as unknown as boolean }, false, false)).toBe(false)
    expect(turnIsAdmin({ admin: 1 as unknown as boolean }, false, false)).toBe(false)
  })

  test("a turn the agent started for itself is, as before", () => {
    expect(turnIsAdmin({}, false, true)).toBe(true)
  })

  test("another agent's question never is, whatever else the message carries", () => {
    const handover = { token: "handover-1" }
    expect(turnIsAdmin({ handover }, false, false)).toBe(false)
    expect(turnIsAdmin({ handover, admin: true }, false, false)).toBe(false)
    // Even under an id the configuration names: a question to the Ranch
    // admin agent must not arrive as its Owner's.
    expect(turnIsAdmin({ handover }, true, false)).toBe(false)
    expect(turnIsAdmin({ handover, admin: true }, true, true)).toBe(false)
  })

  test("an empty hand-over is none", () => {
    expect(turnIsAdmin({ handover: { token: "" }, admin: true }, false, false)).toBe(true)
  })
})
