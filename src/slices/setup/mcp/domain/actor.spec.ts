import { describe, expect, test } from "bun:test"
import { actorLabel, actorOf, actorOfMessage, type IActor } from "./actor"
import { readActing, readHandover } from "../../channel/data/repositories/bridle/bridle.repository"
import { buildMessage } from "../../channel/domain/channel.types"
import { DelegateService } from "../../../runtime/loop/domain/delegate.service"
import type { ILoopContext } from "../../../runtime/loop/domain/loop.types"
import { TaskManager } from "../../../agent/task/domain/task.service"
import { TaskGateway } from "../../../agent/task/data/task.gateway"
import { AGENT_CONFIG_DEFAULTS } from "../../../runtime/init/domain/init.types"

/**
 * Who a turn acts for (CLEAN-232): one test per row of the table in ranch
 * `specs/032-agent-user-access/contracts/acting-party.md` §1.
 */

describe("actorOf", () => {
  test("a message that carried an acting token is that person", () => {
    expect(actorOf({ acting: { token: "tok-1" }, from: "admin", channel: "bridle", isAdmin: true })).toEqual({
      kind: "person",
      token: "tok-1",
    })
  })

  test("the token wins over an internal turn and over a channel admin", () => {
    expect(actorOf({ acting: { token: "tok-1" }, isInternal: true, isAdmin: true, from: "42", channel: "telegram" })).toEqual({
      kind: "person",
      token: "tok-1",
    })
  })

  test("the person carries the token and nothing else", () => {
    const acting = { token: "tok-1", role: "Owner", surface: "admin" }
    expect(Object.keys(actorOf({ acting })).sort()).toEqual(["kind", "token"])
  })

  test("no token, an internal turn: trusted, internal", () => {
    expect(actorOf({ isInternal: true, isAdmin: true, from: "cron", channel: "internal" })).toEqual({
      kind: "trusted",
      via: "internal",
    })
  })

  test("no token, an id from TELEGRAM_BOT_ADMIN_IDS: trusted, channel-admin", () => {
    expect(actorOf({ isAdmin: true, from: "42", channel: "telegram" })).toEqual({
      kind: "trusted",
      via: "channel-admin",
    })
  })

  test("the console admin from-id without a token is a guest", () => {
    expect(actorOf({ isAdmin: true, from: "admin", channel: "bridle" })).toEqual({ kind: "guest" })
    // Whatever channel it claims to be on.
    expect(actorOf({ isAdmin: true, from: "admin", channel: "telegram" })).toEqual({ kind: "guest" })
  })

  test("nothing that arrives over the hub without a token is trusted, even under an admin id", () => {
    expect(actorOf({ isAdmin: true, from: "42", channel: "bridle" })).toEqual({ kind: "guest" })
  })

  test("an empty or malformed token is no token", () => {
    expect(actorOf({ acting: { token: "" }, from: "admin", channel: "bridle", isAdmin: true })).toEqual({ kind: "guest" })
    expect(actorOf({ acting: { token: 7 as unknown as string }, from: "u1", channel: "bridle" })).toEqual({ kind: "guest" })
  })

  test("anyone else is a guest: share visitor, anonymous widget, messenger user", () => {
    expect(actorOf({ from: "share-visitor-7", channel: "bridle", isAdmin: false })).toEqual({ kind: "guest" })
    expect(actorOf({ from: "http-1", channel: "bridle" })).toEqual({ kind: "guest" })
    expect(actorOf({ from: "555", channel: "telegram", isAdmin: false })).toEqual({ kind: "guest" })
    expect(actorOf({})).toEqual({ kind: "guest" })
  })

  test("an actor already resolved for the turn wins: that is how a worker keeps its parent's", () => {
    const guest: IActor = { kind: "guest" }
    expect(actorOf({ actor: guest, isInternal: true, isAdmin: true, from: "admin", channel: "internal" })).toBe(guest)
  })

  test("a label never holds the token", () => {
    expect(actorLabel({ kind: "person", token: "tok-secret" })).toBe("person")
    expect(actorLabel({ kind: "trusted", via: "channel-admin" })).toBe("trusted:channel-admin")
    expect(actorLabel({ kind: "guest" })).toBe("guest")
  })
})

describe("actorOfMessage", () => {
  const message = (from: string, channel: string, acting?: { token: string }) => ({ from, channel, ...(acting ? { acting } : {}) })

  // The second argument is the runtime's own word that its cron or heartbeat
  // module emitted the turn (`turnFlags`, turnOrigin.spec.ts). The message
  // has no say in it.
  test("a turn the runtime says it started is the agent's own", () => {
    expect(actorOfMessage(message("cron", "internal"), true, false)).toEqual({ kind: "trusted", via: "internal" })
    expect(actorOfMessage(message("heartbeat", "internal"), true, false)).toEqual({ kind: "trusted", via: "internal" })
  })

  test("a message named cron or heartbeat is not the agent's own on its word", () => {
    for (const from of ["cron", "heartbeat"]) {
      for (const channel of ["bridle", "telegram", "slack", "internal"]) {
        expect(actorOfMessage(message(from, channel), false, false)).toEqual({ kind: "guest" })
      }
    }
  })

  test("a crash recovery of a visitor's conversation is the visitor's, not the agent's", () => {
    // runtime.module resumes it as internal, under the original channel and from-id, and not self-started.
    expect(actorOfMessage(message("share-visitor-7", "bridle"), false, false)).toEqual({ kind: "guest" })
    expect(actorOfMessage(message("admin", "bridle"), false, true)).toEqual({ kind: "guest" })
    expect(actorOfMessage(message("cron", "bridle"), false, false)).toEqual({ kind: "guest" })
  })

  test("a crash recovery of a configured Telegram admin's conversation stays a channel admin's", () => {
    expect(actorOfMessage(message("42", "telegram"), false, true)).toEqual({ kind: "trusted", via: "channel-admin" })
  })

  test("a console message with a token is the person, without one a guest", () => {
    expect(actorOfMessage(message("admin", "bridle", { token: "tok-1" }), false, true)).toEqual({ kind: "person", token: "tok-1" })
    expect(actorOfMessage(message("admin", "bridle"), false, true)).toEqual({ kind: "guest" })
  })

  test("a task another agent hands over, from a Ranch older than the hand-over token, is a guest's turn", () => {
    // Ranch delivered it over the hub as `peer:<calling agent>:<context>` with no token at all:
    // a colleague is not the Owner, on the Ranch admin agent least of all.
    const task = message("peer:agent-b:ctx-1", "bridle")
    expect(actorOfMessage(task, false, false)).toEqual({ kind: "guest" })
    expect(actorOfMessage(task, false, true)).toEqual({ kind: "guest" })
    // Recovered after a crash it is still the colleague's: a recovery is never self-started.
  })
})

describe("a delegated worker", () => {
  function parentCtx(tasks: TaskManager, over: Partial<ILoopContext>): ILoopContext {
    const task = tasks.start("s", "parent", () => new Promise(() => {}))
    return {
      task,
      sessionId: "s",
      agentDir: "/agent",
      from: "share-visitor-7",
      channel: "bridle",
      isInternal: false,
      systemPrompt: "SOUL",
      history: [],
      tools: [],
      send: async () => {},
      streamSend: async () => undefined,
      agentConfig: AGENT_CONFIG_DEFAULTS,
      reloadSkills: async () => {},
      isAdmin: false,
      ...over,
    }
  }

  async function workerOf(over: Partial<ILoopContext>): Promise<ILoopContext> {
    const tasks = new TaskManager(new TaskGateway())
    const seen: ILoopContext[] = []
    const loop = { run: async (ctx: ILoopContext) => { seen.push(ctx); return { text: "ok", errorLimitHit: false } } }
    const svc = new DelegateService({ tasks, loop, config: { timeoutMs: 5_000, maxParallel: 5, summaryChars: 4000 } })
    await svc.run(parentCtx(tasks, over), [{ goal: "look" }])
    return seen[0]!
  }

  test("inherits a guest parent's actor, although the worker itself runs as an internal task", async () => {
    const worker = await workerOf({ actor: { kind: "guest" } })
    expect(worker.isInternal).toBe(true)
    expect(worker.actor).toEqual({ kind: "guest" })
    expect(actorOf(worker)).toEqual({ kind: "guest" })
  })

  test("inherits a person parent's actor and token", async () => {
    const acting = { token: "tok-1", role: "User" as const, surface: "app" as const }
    const worker = await workerOf({ from: "u1", acting, actor: { kind: "person", token: "tok-1" } })
    expect(worker.actor).toEqual({ kind: "person", token: "tok-1" })
    expect(worker.acting).toEqual(acting)
  })

  test("inherits a colleague's question: the worker's calls belong to the same chain", async () => {
    // CLEAN-236. A worker that became a guest would lose the chain: its
    // ask_agent would start a new one, past the loop and depth checks, and
    // for nobody, where the question was started for a person.
    const worker = await workerOf({ from: "peer:connection-1:ctx-1", actor: { kind: "peer", token: "handover-1" } })
    expect(worker.actor).toEqual({ kind: "peer", token: "handover-1" })
    expect(actorOf(worker)).toEqual({ kind: "peer", token: "handover-1" })
    expect(worker.isAdmin).toBe(false)
  })

  test("a parent with no resolved actor is read from the parent's own facts, not the worker's", async () => {
    const worker = await workerOf({ from: "share-visitor-7", channel: "bridle", isInternal: false, isAdmin: false })
    expect(worker.actor).toEqual({ kind: "guest" })
  })
})

describe("readActing (what the bridle hub sends)", () => {
  // The assistant's level (CLEAN-240): display-only, kept when known.
  test("keeps the assistant's level when it is one this runtime knows", () => {
    expect(readActing({ token: "tok-1", role: "Admin", assistant: { level: "standard" } })).toEqual({
      token: "tok-1",
      role: "Admin",
      assistant: { level: "standard" },
    })
    expect(readActing({ token: "tok-1", role: "Owner", assistant: { level: "owner" } })?.assistant).toEqual({ level: "owner" })
  })

  test("drops a level it does not know, and keeps the person", () => {
    for (const assistant of [{ level: "platinum" }, {}, null, "full", { level: 3 }]) {
      expect(readActing({ token: "tok-1", role: "Admin", assistant })).toEqual({ token: "tok-1", role: "Admin" })
    }
  })

  test("keeps a well-formed acting field", () => {
    expect(readActing({ token: "tok-1", role: "User", surface: "app" })).toEqual({ token: "tok-1", role: "User", surface: "app" })
    expect(readActing({ token: "tok-1", role: "Owner", surface: "admin", extra: 1 })).toEqual({ token: "tok-1", role: "Owner", surface: "admin" })
  })

  test("without a token there is no acting field", () => {
    expect(readActing(undefined)).toBeUndefined()
    expect(readActing("tok-1")).toBeUndefined()
    expect(readActing({ role: "User", surface: "app" })).toBeUndefined()
    expect(readActing({ token: "", role: "User", surface: "app" })).toBeUndefined()
    expect(readActing({ token: "   ", role: "User", surface: "app" })).toBeUndefined()
    expect(readActing({ token: 7, role: "User", surface: "app" })).toBeUndefined()
  })

  test("role and surface are optional, and an unknown one is dropped by itself", () => {
    // An older console build declares no surface: its Owner is still the Owner.
    expect(readActing({ token: "tok-1", role: "Owner" })).toEqual({ token: "tok-1", role: "Owner" })
    expect(readActing({ token: "tok-1", surface: "admin" })).toEqual({ token: "tok-1", surface: "admin" })
    expect(readActing({ token: "tok-1" })).toEqual({ token: "tok-1" })
    expect(readActing({ token: "tok-1", role: "Agent", surface: "app" })).toEqual({ token: "tok-1", surface: "app" })
    expect(readActing({ token: "tok-1", role: "User", surface: "share" })).toEqual({ token: "tok-1", role: "User" })
    expect(readActing({ token: "tok-1", role: 3, surface: null })).toEqual({ token: "tok-1" })
  })

  test("a token with nothing else still makes the sender a person", () => {
    const acting = readActing({ token: "tok-1" })
    expect(actorOf({ acting, from: "admin", channel: "bridle", isAdmin: true })).toEqual({ kind: "person", token: "tok-1" })
  })

  test("the message factory carries it, and leaves it off other messages", () => {
    const base = { id: "m", text: "hi", from: "admin", channel: "bridle", ts: 1 }
    const acting = { token: "tok-1", role: "Admin" as const, surface: "admin" as const }
    expect(buildMessage({ ...base, acting }).acting).toEqual(acting)
    expect("acting" in buildMessage(base)).toBe(false)
  })
})

// CLEAN-236: ranch `specs/033-identity-boundaries/contracts/handover.md` §3.
describe("another agent's question (a hand-over)", () => {
  const question = (extra: Record<string, unknown> = {}) => ({
    from: "peer:connection-1:ctx-1",
    channel: "bridle",
    handover: { token: "handover-1" },
    ...extra,
  })

  test("is a peer, with the token the hub attached and nothing else", () => {
    expect(actorOf(question())).toEqual({ kind: "peer", token: "handover-1" })
    expect(Object.keys(actorOf(question())).sort()).toEqual(["kind", "token"])
  })

  test("wins over every other rule: an acting token, an internal turn, an admin id", () => {
    expect(actorOf(question({ acting: { token: "tok-1" } }))).toEqual({ kind: "peer", token: "handover-1" })
    expect(actorOf(question({ isInternal: true }))).toEqual({ kind: "peer", token: "handover-1" })
    expect(actorOf(question({ isAdmin: true, from: "42", channel: "telegram" }))).toEqual({ kind: "peer", token: "handover-1" })
  })

  test("but not over an actor resolved earlier in the turn", () => {
    expect(actorOf(question({ actor: { kind: "guest" } }))).toEqual({ kind: "guest" })
  })

  test("an empty or malformed hand-over is none, and the rules below apply", () => {
    expect(actorOf(question({ handover: { token: "" } }))).toEqual({ kind: "guest" })
    expect(actorOf(question({ handover: {} as { token: string } }))).toEqual({ kind: "guest" })
    expect(actorOf(question({ handover: { token: "" }, acting: { token: "tok-1" } }))).toEqual({ kind: "person", token: "tok-1" })
  })

  test("the runtime's own word about the turn does not make it trusted", () => {
    const msg = buildMessage({ id: "m", text: "hi", from: "peer:connection-1:ctx-1", channel: "bridle", ts: 1, handover: { token: "handover-1" } })
    expect(actorOfMessage(msg, false, true)).toEqual({ kind: "peer", token: "handover-1" })
    expect(actorOfMessage(msg, true, true)).toEqual({ kind: "peer", token: "handover-1" })
  })

  test("a label never holds the token", () => {
    expect(actorLabel({ kind: "peer", token: "handover-1" })).toBe("peer")
  })
})

describe("readHandover (what the bridle hub sends)", () => {
  test("keeps the token and nothing else", () => {
    expect(readHandover({ token: "handover-1", chain: ["a"], for: "user-1" })).toEqual({ token: "handover-1" })
  })

  test("anything without a token is no hand-over", () => {
    for (const raw of [undefined, null, "handover-1", 7, {}, { token: "" }, { token: "  " }, { token: 7 }, []]) {
      expect(readHandover(raw)).toBeUndefined()
    }
  })

  test("the message factory carries it and the administrator flag, and leaves both off other messages", () => {
    const base = { id: "m", text: "hi", from: "user-7", channel: "bridle", ts: 1 }
    expect(buildMessage({ ...base, handover: { token: "handover-1" } }).handover).toEqual({ token: "handover-1" })
    expect(buildMessage({ ...base, admin: true }).admin).toBe(true)
    const plain = buildMessage(base)
    expect("handover" in plain).toBe(false)
    expect("admin" in plain).toBe(false)
    // Only `true` is the hub's word; anything else is no flag.
    expect("admin" in buildMessage({ ...base, admin: false })).toBe(false)
    expect("admin" in buildMessage({ ...base, admin: "true" as unknown as boolean })).toBe(false)
  })
})
