import { existsSync, mkdirSync } from "fs"
import { readFile, writeFile, rename, unlink } from "fs/promises"
import { join, dirname } from "path"
import { createLogger } from "../../logger"

const log = createLogger("channels")

// `data/channels/<type>.json` — one file per channel, holding EVERYTHING the
// runtime persists about that channel (telegram.json: bot config + group
// registry; slack.json: tokens). Bridle is bootstrap-only (env) and has no
// file. The folder lives in the agent data dir, so it gets picked up by the
// existing S3 sync — the admin can see it via the Files tab.
//
// Channel-specific shapes and helpers live next to their repository
// (repositories/telegram/telegramFile.ts, repositories/slack/slackFile.ts);
// this module owns the shared layout, atomic JSON IO, and the one-time
// migration from the legacy flat files (data/channels.json +
// data/telegram-groups.json).

export type ChannelFileType = "telegram" | "slack"

export function channelsDirPath(agentDir: string): string {
  return join(agentDir, "data", "channels")
}

export function channelFilePath(agentDir: string, type: ChannelFileType): string {
  return join(channelsDirPath(agentDir), `${type}.json`)
}

export async function loadChannelJson<T extends object>(
  agentDir: string,
  type: ChannelFileType,
): Promise<T | null> {
  return readJson<T>(channelFilePath(agentDir, type))
}

export async function saveChannelJson(
  agentDir: string,
  type: ChannelFileType,
  data: object,
): Promise<void> {
  await writeJsonAtomic(channelFilePath(agentDir, type), data)
}

export async function deleteChannelJson(
  agentDir: string,
  type: ChannelFileType,
): Promise<boolean> {
  const path = channelFilePath(agentDir, type)
  if (!existsSync(path)) return false
  await unlink(path)
  return true
}

// ── Channel status file ───────────────────────────────────────
// `data/channels/status.json` — the runtime's report of live channel state,
// written on every start success/failure, replace, and removal. Runtime is
// the ONLY writer; the platform reads it (merged into GET /agents/:id/channels)
// so the admin UI can show connected/disconnected + reason instead of
// guessing from config presence. Absence of the file or of a key means
// "unknown", never "disconnected". Rides the same S3 sync as the config files.

export interface IChannelStatusEntry {
  connected: boolean
  error?: string       // start-failure reason, present only when disconnected
  updatedAt: number    // unix ms of the last state change
}

export type IChannelStatusFile = Record<string, IChannelStatusEntry>

export function channelStatusPath(agentDir: string): string {
  return join(channelsDirPath(agentDir), "status.json")
}

export async function loadChannelStatus(agentDir: string): Promise<IChannelStatusFile> {
  return (await readJson<IChannelStatusFile>(channelStatusPath(agentDir))) ?? {}
}

/**
 * Read-modify-write a single channel's status entry. Pass null to drop the
 * entry (channel removed — its state is no longer known, not "disconnected").
 */
export async function updateChannelStatus(
  agentDir: string,
  type: string,
  entry: IChannelStatusEntry | null,
): Promise<void> {
  const file = await loadChannelStatus(agentDir)
  if (entry === null) delete file[type]
  else file[type] = entry
  await writeJsonAtomic(channelStatusPath(agentDir), file)
}

// ── Legacy migration ──────────────────────────────────────────
// Pre-0.23 layouts stored everything in flat files:
//   data/channels.json         { telegram: {botToken,...}, slack: {...} }
//   data/telegram-groups.json  { groups: {...} }
// Runs once at boot: splits them into data/channels/<type>.json and removes
// the legacy files. A legacy file never overwrites an existing per-channel
// file — the new layout wins.

interface ILegacyChannelsFile {
  telegram?: { botToken?: string; botName?: string; adminIds?: string }
  slack?: { botToken?: string; appToken?: string }
}

export async function migrateLegacyChannelFiles(agentDir: string): Promise<void> {
  const legacyChannelsPath = join(agentDir, "data", "channels.json")
  const legacyGroupsPath = join(agentDir, "data", "telegram-groups.json")
  const hasLegacyChannels = existsSync(legacyChannelsPath)
  const hasLegacyGroups = existsSync(legacyGroupsPath)
  if (!hasLegacyChannels && !hasLegacyGroups) return

  const legacy = hasLegacyChannels
    ? (await readJson<ILegacyChannelsFile>(legacyChannelsPath)) ?? {}
    : {}
  const legacyGroups = hasLegacyGroups
    ? (await readJson<{ groups?: Record<string, unknown> }>(legacyGroupsPath))?.groups
    : undefined

  if (legacy.telegram?.botToken || legacyGroups) {
    if (existsSync(channelFilePath(agentDir, "telegram"))) {
      log.warn("legacy telegram data found but channels/telegram.json already exists — keeping the new file")
    } else {
      await saveChannelJson(agentDir, "telegram", {
        ...(legacy.telegram ?? {}),
        ...(legacyGroups ? { groups: legacyGroups } : {}),
      })
      log.info("migrated telegram channel data to data/channels/telegram.json")
    }
  }

  if (legacy.slack?.botToken) {
    if (existsSync(channelFilePath(agentDir, "slack"))) {
      log.warn("legacy slack data found but channels/slack.json already exists — keeping the new file")
    } else {
      await saveChannelJson(agentDir, "slack", legacy.slack)
      log.info("migrated slack channel data to data/channels/slack.json")
    }
  }

  if (hasLegacyChannels) await unlink(legacyChannelsPath)
  if (hasLegacyGroups) await unlink(legacyGroupsPath)
}

// ── JSON IO ───────────────────────────────────────────────────

async function readJson<T extends object>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    const text = await readFile(path, "utf-8")
    if (!text.trim()) return null
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as T
  } catch (err) {
    log.warn(`failed to parse ${path}`, err)
    return null
  }
}

async function writeJsonAtomic(path: string, data: object): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  // Atomic write: temp + rename. Avoids the S3 watcher seeing a half-written
  // file mid-update.
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8")
  await rename(tmp, path)
}
