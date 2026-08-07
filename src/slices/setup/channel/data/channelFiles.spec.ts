import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  channelFilePath,
  channelStatusPath,
  loadChannelStatus,
  migrateLegacyChannelFiles,
  updateChannelStatus,
} from "./channelFiles"
import { loadTelegramFile } from "./repositories/telegram/telegramFile"
import { loadSlackFile } from "./repositories/slack/slackFile"

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "channels-"))
  mkdirSync(join(dir, "data"), { recursive: true })
  return dir
}

describe("migrateLegacyChannelFiles", () => {
  test("no legacy files → no-op", async () => {
    const dir = agentDir()
    await migrateLegacyChannelFiles(dir)
    expect(existsSync(channelFilePath(dir, "telegram"))).toBe(false)
    expect(existsSync(channelFilePath(dir, "slack"))).toBe(false)
  })

  test("splits legacy channels.json into per-channel files and deletes it", async () => {
    const dir = agentDir()
    const legacyPath = join(dir, "data", "channels.json")
    await Bun.write(legacyPath, JSON.stringify({
      telegram: { botToken: "123:abc", botName: "mybot", adminIds: "42" },
      slack: { botToken: "xoxb-1", appToken: "xapp-1" },
    }))

    await migrateLegacyChannelFiles(dir)

    const telegram = await loadTelegramFile(dir)
    expect(telegram.botToken).toBe("123:abc")
    expect(telegram.botName).toBe("mybot")
    const slack = await loadSlackFile(dir)
    expect(slack.appToken).toBe("xapp-1")
    expect(existsSync(legacyPath)).toBe(false)
  })

  test("merges legacy telegram-groups.json into telegram.json and deletes it", async () => {
    const dir = agentDir()
    const legacyChannels = join(dir, "data", "channels.json")
    const legacyGroups = join(dir, "data", "telegram-groups.json")
    await Bun.write(legacyChannels, JSON.stringify({ telegram: { botToken: "123:abc" } }))
    await Bun.write(legacyGroups, JSON.stringify({
      groups: { "-100": { id: "-100", type: "supergroup", title: "News", status: "member", addedAt: 1, lastSeenAt: 2 } },
    }))

    await migrateLegacyChannelFiles(dir)

    const telegram = await loadTelegramFile(dir)
    expect(telegram.botToken).toBe("123:abc")
    expect(telegram.groups?.["-100"]?.title).toBe("News")
    expect(existsSync(legacyChannels)).toBe(false)
    expect(existsSync(legacyGroups)).toBe(false)
  })

  test("existing per-channel file wins over legacy", async () => {
    const dir = agentDir()
    await Bun.write(channelFilePath(dir, "telegram"), JSON.stringify({ botToken: "new:token" }))
    const legacyPath = join(dir, "data", "channels.json")
    await Bun.write(legacyPath, JSON.stringify({ telegram: { botToken: "old:token" } }))

    await migrateLegacyChannelFiles(dir)

    const telegram = await loadTelegramFile(dir)
    expect(telegram.botToken).toBe("new:token")
    expect(existsSync(legacyPath)).toBe(false)
  })

  test("groups-only legacy file (no channels.json) still migrates", async () => {
    const dir = agentDir()
    const legacyGroups = join(dir, "data", "telegram-groups.json")
    await Bun.write(legacyGroups, JSON.stringify({
      groups: { "-100": { id: "-100", type: "group", status: "member", addedAt: 1, lastSeenAt: 2 } },
    }))

    await migrateLegacyChannelFiles(dir)

    const telegram = await loadTelegramFile(dir)
    expect(telegram.groups?.["-100"]?.type).toBe("group")
    expect(existsSync(legacyGroups)).toBe(false)
  })
})

describe("channel status file", () => {
  test("missing file → empty, update/read/drop round-trip", async () => {
    const dir = agentDir()
    expect(await loadChannelStatus(dir)).toEqual({})

    await updateChannelStatus(dir, "telegram", { connected: true, updatedAt: 100 })
    await updateChannelStatus(dir, "bridle", { connected: false, error: "socket closed", updatedAt: 200 })

    const status = await loadChannelStatus(dir)
    expect(status.telegram).toEqual({ connected: true, updatedAt: 100 })
    expect(status.bridle?.error).toBe("socket closed")
    expect(existsSync(channelStatusPath(dir))).toBe(true)

    // null drops the entry (removed channel = unknown, not disconnected)
    await updateChannelStatus(dir, "telegram", null)
    expect((await loadChannelStatus(dir)).telegram).toBeUndefined()
    expect((await loadChannelStatus(dir)).bridle).toBeDefined()
  })
})
