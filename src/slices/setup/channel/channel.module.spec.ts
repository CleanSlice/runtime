import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ChannelModule } from "./channel.module"
import { saveTelegramFile } from "./data/repositories/telegram/telegramFile"
import type { IChannelGateway } from "./domain/channel.gateway"

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "channel-module-"))
  mkdirSync(join(dir, "data"), { recursive: true })
  return dir
}

function mockGateway(name = "mock"): IChannelGateway {
  return {
    name,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: () => Promise.resolve(),
    onMessage: () => {},
  }
}

// resolveBootConfigs / reconcileFromDisk mutate the env mirror — isolate it.
const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_NAME", "TELEGRAM_BOT_ADMIN_IDS",
  "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "BRIDLE_URL",
] as const
let envSnapshot: Record<string, string | undefined>

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k]
    else process.env[k] = envSnapshot[k]
  }
})

describe("resolveBootConfigs", () => {
  test("file with credentials wins over env", async () => {
    const dir = agentDir()
    await saveTelegramFile(dir, { botToken: "file:token" })
    process.env.TELEGRAM_BOT_TOKEN = "env:token"

    const configs = await ChannelModule.resolveBootConfigs(dir)

    const telegram = configs.find(c => c.type === "telegram")
    expect(telegram).toEqual({ type: "telegram", token: "file:token" })
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("file:token")
  })

  test("tombstone (removed: true) suppresses the env fallback", async () => {
    const dir = agentDir()
    await saveTelegramFile(dir, { removed: true })
    process.env.TELEGRAM_BOT_TOKEN = "env:token"

    const configs = await ChannelModule.resolveBootConfigs(dir)

    expect(configs.find(c => c.type === "telegram")).toBeUndefined()
  })

  test("groups-only file (env-configured bot) keeps the env fallback", async () => {
    const dir = agentDir()
    // The group tracker persists groups into telegram.json even when the bot
    // config came from env — that file is NOT a tombstone.
    await saveTelegramFile(dir, {
      groups: { "-100": { id: "-100", type: "group", status: "member", addedAt: 1, lastSeenAt: 2 } },
    })
    process.env.TELEGRAM_BOT_TOKEN = "env:token"

    const configs = await ChannelModule.resolveBootConfigs(dir)

    expect(configs.find(c => c.type === "telegram")).toEqual({ type: "telegram", token: "env:token" })
  })

  test("no file and no env → no telegram config", async () => {
    const dir = agentDir()
    const configs = await ChannelModule.resolveBootConfigs(dir)
    expect(configs.find(c => c.type === "telegram")).toBeUndefined()
  })
})

describe("reconcileFromDisk", () => {
  test("config file that appeared after construction registers the channel", async () => {
    const dir = agentDir()
    // Simulates the k8s boot race: empty disk at construction, S3 pull lands
    // telegram.json before connectChannels().
    const module = new ChannelModule([], dir)
    await saveTelegramFile(dir, { botToken: "123:pulled" })

    await module.reconcileFromDisk()

    const info = await module.listInfo()
    const telegram = info.find(i => i.type === "telegram")
    expect(telegram?.source).toBe("file")
    expect(telegram?.connected).toBe(true) // registered in the service (starts with service.start())
  })

  test("token change on disk replaces the registered gateway", async () => {
    const dir = agentDir()
    const module = new ChannelModule([{ type: "telegram", token: "env:old" }], dir)
    await saveTelegramFile(dir, { botToken: "file:new" })

    await module.reconcileFromDisk()

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("file:new")
    const telegram = (await module.listInfo()).find(i => i.type === "telegram")
    expect(telegram?.connected).toBe(true)
  })

  test("unchanged config is left alone", async () => {
    const dir = agentDir()
    await saveTelegramFile(dir, { botToken: "123:same" })
    const module = new ChannelModule(
      await ChannelModule.resolveBootConfigs(dir),
      dir,
    )

    await module.reconcileFromDisk()

    const telegram = (await module.listInfo()).find(i => i.type === "telegram")
    expect(telegram?.connected).toBe(true)
  })

  test("tombstone deregisters a previously registered channel", async () => {
    const dir = agentDir()
    const module = new ChannelModule([{ type: "telegram", token: "env:old" }], dir)
    await saveTelegramFile(dir, { removed: true })
    process.env.TELEGRAM_BOT_TOKEN = "env:old" // pod env survives until redeploy

    await module.reconcileFromDisk()

    expect((await module.listInfo()).find(i => i.type === "telegram")).toBeUndefined()
    expect(module.send("telegram", "1", "hi")).rejects.toThrow("Channel not found")
  })

  test("mock-only setups are untouched (paddock/test harness)", async () => {
    const dir = agentDir()
    const module = new ChannelModule([{ type: "mock", instance: mockGateway() }], dir)
    await saveTelegramFile(dir, { botToken: "123:abc" })

    await module.reconcileFromDisk()

    expect(module.send("telegram", "1", "hi")).rejects.toThrow("Channel not found")
  })

  test("no agentDir → no-op", async () => {
    const module = new ChannelModule([])
    await module.reconcileFromDisk() // must not throw
  })
})
