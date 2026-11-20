import { describe, expect, test } from "bun:test"
import { BotService } from "./bot.service"
import { GateTypes, gateFor } from "./gate"
import { buildMessage, type Message } from "../../../setup/channel/domain/channel.types"

/**
 * Who is at the door (CLEAN-236; ranch
 * `specs/033-identity-boundaries/contracts/handover.md` §3). Two senders the
 * access list cannot know by their id: a console Admin, who has their own
 * conversation now, and another agent's question.
 */

describe("gateFor", () => {
  const handover = { token: "handover-1" }

  test("a message with a hand-over is a colleague's question", () => {
    expect(gateFor({ handover }, false)).toBe(GateTypes.Colleague)
  })

  test("and stays one whatever else is said of the sender", () => {
    expect(gateFor({ handover }, true)).toBe(GateTypes.Colleague)
  })

  test("an administrator is an administrator, everybody else a visitor", () => {
    expect(gateFor({}, true)).toBe(GateTypes.Admin)
    expect(gateFor({}, false)).toBe(GateTypes.Visitor)
  })

  test("an empty hand-over is none", () => {
    expect(gateFor({ handover: { token: "" } }, false)).toBe(GateTypes.Visitor)
    expect(gateFor({ handover: { token: "" } }, true)).toBe(GateTypes.Admin)
  })
})

/** `BotService` with everything around it recorded. */
function make(opts: { adminIds?: string[]; allowed?: string[]; pendingCode?: string } = {}) {
  const sent: Array<{ to: string; text: string }> = []
  const commands: Array<{ from: string; text: string; isAdmin?: boolean }> = []
  const asked: string[] = []
  const registered: string[] = []
  const approved: string[] = []
  const access = {
    isAdmin: (id: string) => (opts.adminIds ?? ["admin"]).includes(id),
    isAllowed: (id: string) => {
      asked.push(id)
      return (opts.allowed ?? []).includes(id)
    },
    getUser: () => undefined,
    registerPending: (id: string) => {
      registered.push(id)
      return { userId: id, status: "pending", accessCode: "ABC123", createdAt: 0 }
    },
    approve: (code: string) => {
      if (code !== opts.pendingCode) return undefined
      approved.push(code)
      return { userId: "42", status: "active", createdAt: 0 }
    },
  }
  const bot = new BotService({
    access: access as never,
    commands: {
      handle: async (ctx: { from: string; text: string; isAdmin?: boolean }) => {
        commands.push({ from: ctx.from, text: ctx.text, isAdmin: ctx.isAdmin })
        return { handled: ctx.text.startsWith("/") }
      },
    } as never,
    tasks: { getRunningBySessionId: () => [], cancelAll: () => 0, inject: () => false } as never,
    router: { route: async () => ({ kind: "new" }), clear: () => {} } as never,
    session: { append: async () => {} } as never,
    channel: { send: async (_ch: string, to: string, text: string) => { sent.push({ to, text }) } } as never,
    stopPhrases: new Set(["stop"]),
  })
  return { bot, sent, commands, asked, registered, approved }
}

const hub = (from: string, text: string, extra: Partial<Message> = {}): Message =>
  buildMessage({ id: "m", text, from, channel: "bridle", ts: 1, ...extra })

describe("BotService.route — a console Admin under their own id", () => {
  test("is let in without the access strategy being asked, where they were sent an access code", async () => {
    const { bot, sent, asked, registered } = make()

    expect(await bot.route(hub("user-a", "hello", { admin: true }), "s")).toEqual({ action: "new-task" })
    expect(asked).toEqual([])
    expect(registered).toEqual([])
    expect(sent).toEqual([])
  })

  test("runs commands as an administrator", async () => {
    const { bot, commands } = make()

    await bot.route(hub("user-a", "/context", { admin: true }), "s")

    expect(commands).toEqual([{ from: "user-a", text: "/context", isAdmin: true }])
  })

  test("approves an access code, as the Owner does", async () => {
    const { bot, approved, sent } = make({ pendingCode: "ABC123" })

    expect(await bot.route(hub("user-a", "ABC123", { admin: true }), "s")).toEqual({ action: "handled" })
    expect(approved).toEqual(["ABC123"])
    expect(sent.map((s) => s.to)).toEqual(["42", "user-a"])
  })

  test("the same id without the hub's word is a visitor: gated, and approves nothing", async () => {
    const { bot, approved, asked, commands, sent } = make({ pendingCode: "ABC123" })

    expect(await bot.route(hub("user-a", "ABC123"), "s")).toEqual({ action: "handled" })
    expect(approved).toEqual([])
    expect(commands[0]!.isAdmin).toBe(false)
    expect(asked).toEqual(["user-a"])
    expect(sent[0]!.text).toContain("Access denied")
  })

  test("the Owner, still `admin`, is an administrator with or without the flag", async () => {
    for (const extra of [{}, { admin: true }]) {
      const { bot, commands, asked } = make()
      await bot.route(hub("admin", "/context", extra), "s")
      expect(commands).toEqual([{ from: "admin", text: "/context", isAdmin: true }])
      expect(asked).toEqual([])
    }
  })
})

describe("BotService.route — another agent's question", () => {
  const question = (text: string, extra: Partial<Message> = {}) =>
    hub("peer:connection-1:ctx-1", text, { handover: { token: "handover-1" }, ...extra })

  test("is let through: no access check, no pending visitor, no access code sent back as the answer", async () => {
    const { bot, asked, registered, sent } = make()

    expect(await bot.route(question("What is the refund policy?"), "s")).toEqual({ action: "new-task" })
    expect(asked).toEqual([])
    expect(registered).toEqual([])
    expect(sent).toEqual([])
  })

  test("runs no slash command: the text is a question, not somebody typing in this chat", async () => {
    const { bot, commands } = make()

    expect(await bot.route(question("/access open"), "s")).toEqual({ action: "new-task" })
    expect(commands).toEqual([])
  })

  test("approves no access code, even one that is pending, even flagged an administrator's", async () => {
    const { bot, approved } = make({ pendingCode: "ABC123" })

    await bot.route(question("ABC123"), "s")
    await bot.route(question("ABC123", { admin: true }), "s")

    expect(approved).toEqual([])
  })

  test("a message named like one, with no hand-over, is a visitor's: an older Ranch, or somebody who chose the name", async () => {
    const { bot, asked, sent } = make()

    expect(await bot.route(hub("peer:connection-1:ctx-1", "hi"), "s")).toEqual({ action: "handled" })
    expect(asked).toEqual(["peer:connection-1:ctx-1"])
    expect(sent[0]!.text).toContain("Access denied")
  })
})

describe("BotService.route — everybody else, as before", () => {
  test("a visitor the strategy lets in starts a task", async () => {
    const { bot, asked } = make({ allowed: ["share-7"] })

    expect(await bot.route(hub("share-7", "hello"), "s")).toEqual({ action: "new-task" })
    expect(asked).toEqual(["share-7"])
  })

  test("a visitor it does not is registered and sent their code", async () => {
    const { bot, registered, sent } = make()

    expect(await bot.route(hub("share-7", "hello"), "s")).toEqual({ action: "handled" })
    expect(registered).toEqual(["share-7"])
    expect(sent[0]!.text).toContain("ABC123")
  })

  test("a command is handled before the access check, as it always was", async () => {
    const { bot, asked, commands } = make()

    expect(await bot.route(hub("share-7", "/start"), "s")).toEqual({ action: "handled" })
    expect(commands).toEqual([{ from: "share-7", text: "/start", isAdmin: false }])
    expect(asked).toEqual([])
  })
})
