import { existsSync, mkdirSync } from "fs"
import { readFile, writeFile, rename, unlink } from "fs/promises"
import { join, dirname } from "path"
import { createLogger } from "../../logger"

const log = createLogger("channels")

// `channels.json` — single source of truth for runtime-managed channels.
// Bridle is bootstrap-only (env) and not tracked here.
// The file lives in the agent data dir, so it gets picked up by the existing
// S3 sync — the admin can see it via the Files tab.

export interface ITelegramFileEntry {
  botToken: string
  botName?: string
  adminIds?: string
}

export interface ISlackFileEntry {
  botToken: string
  appToken: string
}

export interface IChannelsFile {
  telegram?: ITelegramFileEntry
  slack?: ISlackFileEntry
}

export type ChannelFileType = keyof IChannelsFile

export function channelsFilePath(agentDir: string): string {
  return join(agentDir, "data", "channels.json")
}

export async function loadChannelsFile(agentDir: string): Promise<IChannelsFile> {
  const path = channelsFilePath(agentDir)
  if (!existsSync(path)) return {}
  try {
    const text = await readFile(path, "utf-8")
    if (!text.trim()) return {}
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as IChannelsFile
  } catch (err) {
    log.warn(`failed to parse ${path}`, err)
    return {}
  }
}

export async function saveChannelsFile(
  agentDir: string,
  file: IChannelsFile,
): Promise<void> {
  const path = channelsFilePath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  // Atomic write: temp + rename. Avoids the S3 watcher seeing a half-written
  // file mid-update.
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf-8")
  await rename(tmp, path)
}

export async function deleteChannelsFile(agentDir: string): Promise<void> {
  const path = channelsFilePath(agentDir)
  if (!existsSync(path)) return
  await unlink(path)
}
