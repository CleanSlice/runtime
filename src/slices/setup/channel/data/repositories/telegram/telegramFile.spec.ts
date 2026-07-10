import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
import { readFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  type ITelegramGroupEntry,
  loadTelegramFile,
  saveTelegramFile,
  updateTelegramFile,
  telegramFilePath,
} from "./telegramFile"

function group(overrides: Partial<ITelegramGroupEntry> = {}): ITelegramGroupEntry {
  return {
    id: "-1001234567890",
    type: "supergroup",
    title: "Dreamvention News",
    status: "member",
    addedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_100_000,
    ...overrides,
  }
}

describe("telegramFile", () => {
  test("missing file → empty object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-file-"))
    expect(await loadTelegramFile(dir)).toEqual({})
  })

  test("file lands under data/channels/", () => {
    expect(telegramFilePath("/agent")).toBe("/agent/data/channels/telegram.json")
  })

  test("save + load round-trip with config and groups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-file-"))
    const g = group({ username: "dreamvention_news" })
    await saveTelegramFile(dir, {
      botToken: "123:abc",
      botName: "mybot",
      groups: { [g.id]: g },
    })
    const loaded = await loadTelegramFile(dir)
    expect(loaded.botToken).toBe("123:abc")
    expect(loaded.groups?.[g.id]).toEqual(g)
  })

  test("updateTelegramFile patches groups without touching config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-file-"))
    await saveTelegramFile(dir, { botToken: "123:abc", adminIds: "42" })
    const g = group()
    await updateTelegramFile(dir, { groups: { [g.id]: g } })
    const loaded = await loadTelegramFile(dir)
    expect(loaded.botToken).toBe("123:abc")
    expect(loaded.adminIds).toBe("42")
    expect(loaded.groups?.[g.id]).toEqual(g)
  })

  test("updateTelegramFile patches config without touching groups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-file-"))
    const g = group()
    await saveTelegramFile(dir, { botToken: "old:token", groups: { [g.id]: g } })
    await updateTelegramFile(dir, { botToken: "new:token" })
    const loaded = await loadTelegramFile(dir)
    expect(loaded.botToken).toBe("new:token")
    expect(loaded.groups?.[g.id]).toEqual(g)
  })

  test("corrupt json → empty object, no throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-file-"))
    await Bun.write(telegramFilePath(dir), "{not json")
    expect(await loadTelegramFile(dir)).toEqual({})
  })

  test("no leftover tmp file after save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-file-"))
    await saveTelegramFile(dir, {})
    await expect(readFile(`${telegramFilePath(dir)}.tmp`)).rejects.toThrow()
  })
})
