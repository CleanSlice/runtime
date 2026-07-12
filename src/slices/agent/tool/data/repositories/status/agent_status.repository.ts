import { z } from "zod"
import { readdir } from "fs/promises"
import { join } from "path"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import type { IChannelInfo } from "../../../../../setup/channel/channel.module"
import pkg from "../../../../../../../package.json"

const schema = z.object({})

interface IAgentStatusReport {
  capturedAt: number
  runtime: { version: string; agentDir: string }
  caller: {
    id?: string
    channel?: string
    isAdmin: boolean
    /** Access record status for this user: admin / active / pending — absent for internal or unknown callers. */
    accessStatus?: string
  }
  session: { id: string }
  llm?: { provider: string; model: string; contextWindow: number }
  capabilities: {
    total: number
    builtin: string[]
    /** Visible tools flagged adminOnly — empty for non-admin callers because those are filtered out upstream. */
    adminOnly: string[]
    /** MCP tools grouped by server name (the `<server>__<tool>` prefix). */
    mcp: Record<string, string[]>
  }
  skills: string[]
  // ── Admin-only sections below — omitted entirely for non-admin callers ──
  access?: { strategy: string; users: { total: number; active: number; pending: number } }
  channels?: IChannelInfo[]
  usageToday?: { inputTokens: number; outputTokens: number; callCount: number }
  environment?: { ranchAdmin: boolean; bridleConnected: boolean; s3Sync: boolean }
}

export const AgentStatusTool: Tool = {
  name: "agent_status",
  description: `Report your own configuration and capabilities for the CURRENT session.

Returns a structured snapshot:
  - caller: who you are talking to right now — their id, channel (telegram/bridle/...), whether they are an ADMIN, and their access status.
  - runtime: agent runtime version and agent directory.
  - llm: provider, model, context window.
  - capabilities: every tool YOU can invoke for this caller — built-in tools, admin-only tools, and MCP tools grouped by server. Admin-only tools are already hidden when the caller is not admin, so this list is exactly what you may use.
  - skills: skills installed in your skills/ directory.
  - For ADMIN callers only: access strategy + user counts, connected channels (tokens masked), today's token usage, and environment flags (ranch admin mode, bridle, S3 sync).

Call this when:
  - The user asks what you can do, what tools/skills you have, or how you are configured.
  - The user asks whether you recognize them as admin, or why an action is unavailable.
  - You are unsure whether the current peer is admin before offering admin-only actions.

Safe for any caller — the report is trimmed to what the current user is allowed to know.`,
  schema,
  async execute(_params: unknown, ctx: ToolContext): Promise<IAgentStatusReport> {
    const isAdmin = ctx.isAdmin ?? false
    const visible = ctx.tools ?? []

    const builtin: string[] = []
    const mcp: Record<string, string[]> = {}
    for (const tool of visible) {
      const sep = tool.name.indexOf("__")
      if (sep > 0) {
        const server = tool.name.slice(0, sep)
        ;(mcp[server] ??= []).push(tool.name.slice(sep + 2))
      } else {
        builtin.push(tool.name)
      }
    }
    const adminOnly = visible.filter(t => t.adminOnly).map(t => t.name)

    let skills: string[] = []
    try {
      const entries = await readdir(join(ctx.agentDir, "skills"))
      skills = entries
        .filter(e => !e.startsWith("."))
        .map(e => e.replace(/\.md$/, ""))
    } catch {
      // No skills directory — standalone agents may not have one.
    }

    const snapshot = ctx.llm?.getResourceSnapshot()

    const report: IAgentStatusReport = {
      capturedAt: Date.now(),
      runtime: { version: pkg.version, agentDir: ctx.agentDir },
      caller: {
        id: ctx.from,
        channel: ctx.channel,
        isAdmin,
        accessStatus: ctx.from ? ctx.access?.getUser(ctx.from)?.status : undefined,
      },
      session: { id: ctx.sessionId },
      llm: snapshot
        ? { provider: snapshot.provider, model: snapshot.model, contextWindow: snapshot.contextWindow }
        : undefined,
      capabilities: { total: visible.length, builtin, adminOnly, mcp },
      skills,
    }

    if (isAdmin) {
      if (ctx.access) {
        report.access = { strategy: ctx.access.getStrategyName(), users: ctx.access.stats() }
      }
      report.channels = await ctx.channels?.listInfo()
      const today = ctx.usage?.getCurrent()
      if (today) {
        report.usageToday = {
          inputTokens: today.totalInputTokens,
          outputTokens: today.totalOutputTokens,
          callCount: today.totalCallCount,
        }
      }
      report.environment = {
        ranchAdmin: process.env.RANCH_ADMIN === "true",
        bridleConnected: !!process.env.BRIDLE_URL,
        s3Sync: !!process.env.S3_BUCKET,
      }
    }

    return report
  },
}
