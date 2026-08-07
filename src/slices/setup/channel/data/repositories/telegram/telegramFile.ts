import {
  loadChannelJson,
  saveChannelJson,
  deleteChannelJson,
  channelFilePath,
} from "../../channelFiles"

// `data/channels/telegram.json` — the single file for EVERYTHING the runtime
// persists about Telegram: bot config (token, name, admins) and the registry
// of groups/channels the bot works in. Telegram's Bot API has no "list my
// chats" endpoint, so the registry is the only durable record of where the
// bot operates. It's fed by `message` and `my_chat_member` updates and read
// by the `telegram_groups` tool to resolve group chat ids.

export interface ITelegramGroupEntry {
  id: string                 // chat id, e.g. "-1001234567890" — usable with telegram_send
  type: "group" | "supergroup" | "channel"
  title?: string
  username?: string          // public @handle, when the group/channel has one
  // Bot's membership per Telegram: member | administrator | creator |
  // restricted | left | kicked. Entries are kept after the bot leaves so the
  // agent knows the group existed — check status before sending.
  status: string
  addedAt: number            // first time the bot saw this chat (unix ms)
  lastSeenAt: number         // last message or membership update seen (unix ms)
}

export interface ITelegramFile {
  botToken?: string
  botName?: string
  adminIds?: string          // comma-separated Telegram chat ids treated as admins
  // Tombstone: channel was explicitly removed. Mutually exclusive with
  // credentials — a removed-file must not fall back to TELEGRAM_* env vars
  // (the pod env keeps the old token until the next redeploy, and without
  // the tombstone a restart would resurrect the deleted channel).
  removed?: boolean
  groups?: Record<string, ITelegramGroupEntry>
}

export function telegramFilePath(agentDir: string): string {
  return channelFilePath(agentDir, "telegram")
}

export async function loadTelegramFile(agentDir: string): Promise<ITelegramFile> {
  return (await loadChannelJson<ITelegramFile>(agentDir, "telegram")) ?? {}
}

export async function saveTelegramFile(agentDir: string, file: ITelegramFile): Promise<void> {
  await saveChannelJson(agentDir, "telegram", file)
}

export async function deleteTelegramFile(agentDir: string): Promise<boolean> {
  return deleteChannelJson(agentDir, "telegram")
}

/**
 * Read-modify-write: both the channel module (config) and the telegram
 * repository (groups) write to the same file — patch only your fields so
 * one writer never clobbers the other's.
 */
export async function updateTelegramFile(
  agentDir: string,
  patch: Partial<ITelegramFile>,
): Promise<ITelegramFile> {
  const next = { ...(await loadTelegramFile(agentDir)), ...patch }
  await saveTelegramFile(agentDir, next)
  return next
}
