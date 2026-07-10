import {
  loadChannelJson,
  saveChannelJson,
  deleteChannelJson,
  channelFilePath,
} from "../../channelFiles"

// `data/channels/slack.json` — everything the runtime persists about Slack.

export interface ISlackFile {
  botToken?: string
  appToken?: string
}

export function slackFilePath(agentDir: string): string {
  return channelFilePath(agentDir, "slack")
}

export async function loadSlackFile(agentDir: string): Promise<ISlackFile> {
  return (await loadChannelJson<ISlackFile>(agentDir, "slack")) ?? {}
}

export async function saveSlackFile(agentDir: string, file: ISlackFile): Promise<void> {
  await saveChannelJson(agentDir, "slack", file)
}

export async function deleteSlackFile(agentDir: string): Promise<boolean> {
  return deleteChannelJson(agentDir, "slack")
}
