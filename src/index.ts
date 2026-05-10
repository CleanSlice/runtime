// Load .env file
import { readFileSync, existsSync } from "fs"
if (existsSync(".env")) {
  const lines = readFileSync(".env", "utf-8").split("\n")
  for (const line of lines) {
    const [key, ...rest] = line.split("=")
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim()
  }
}

// Prevent unhandled promise rejections from crashing the bot
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] caught:", reason)
})



// Validate env vars.
// Canonical contract: LLM_API_KEY for LLM creds, BRIDLE_URL / TELEGRAM_BOT_* /
// SLACK_* for channels. Legacy provider-specific keys (ANTHROPIC_API_KEY,
// DEEPSEEK_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)
// still work as `??` fallbacks deeper in the stack but should not be set by
// new agents. Showing them in `[env] ok:` makes leftover values visible.
const knownEnv = [
  // LLM (canonical)
  "LLM_PROVIDER", "LLM_MODEL", "LLM_FALLBACK_MODEL", "LLM_API_KEY",
  // LLM auxiliary (background work: compaction, summarization). When unset,
  // aux falls back to the main LLM. Set LLM_AUX_MODEL alone to use a smaller
  // model on the same provider/key.
  "LLM_AUX_PROVIDER", "LLM_AUX_MODEL", "LLM_AUX_FALLBACK_MODEL", "LLM_AUX_API_KEY",
  // LLM (legacy — flag if present)
  "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Channels
  "BRIDLE_URL", "BRIDLE_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_NAME", "TELEGRAM_BOT_ADMIN_IDS",
  "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
  // Storage / secrets
  "SECRET_PROVIDER", "S3_BUCKET", "S3_PREFIX", "S3_ENDPOINT",
  "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SECRET_PREFIX",
  // MCP — base64(JSON array of IMcpServerConfig) populated by the deploy pipeline.
  // Base64 because the deploy pipeline injects this into a YAML manifest.
  "MCP_SERVERS_B64",
  // Misc
  "ELEVENLABS_API_KEY", "CLEANSLICE_AGENT_DIR", "PORT",
]
const setEnv = knownEnv.filter(k => process.env[k])
if (setEnv.length) console.log(`[env] ok: ${setEnv.join(", ")}`)

const hasChannel = !!(process.env.BRIDLE_URL || process.env.TELEGRAM_BOT_TOKEN || (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN))
const hasLlmCred = !!process.env.LLM_API_KEY
if (!hasChannel) console.warn("[env] ⚠ no channel configured (set BRIDLE_URL, TELEGRAM_BOT_TOKEN, or SLACK_BOT_TOKEN+SLACK_APP_TOKEN)")
if (!hasLlmCred) console.warn("[env] ⚠ LLM_API_KEY not set")

import pkg from "../package.json"
import { AgentRuntime } from "./runtime"
import type { LlmConfig } from "./slices/setup/llm/llm.module"
import { ToolGateway } from "./slices/agent/tool/data/tool.gateway"
import { InitModule } from "./slices/runtime/init"
import { McpModule } from "./slices/setup/mcp"

/**
 * Build an LlmConfig from a (provider, model, fallbackModel, apiKey) tuple.
 * Shared by main LLM and auxiliary LLM resolution so behavior stays consistent.
 * Defaults to "claude" when provider is missing.
 */
function buildLlmConfig(
  provider: string | undefined,
  model: string | undefined,
  fallbackModel: string | undefined,
  apiKey: string | undefined,
): LlmConfig {
  const p = provider ?? "claude"
  switch (p) {
    case "deepseek":
      return {
        provider: "deepseek",
        model: model ?? "deepseek-chat",
        fallbackModel,
        apiKey: apiKey ?? process.env.DEEPSEEK_API_KEY,
      }
    case "google":
      return {
        provider: "google",
        model: model ?? "gemini-2.0-flash",
        fallbackModel,
        apiKey: apiKey ?? process.env.GOOGLE_API_KEY,
      }
    case "mistral":
      return {
        provider: "mistral",
        model: model ?? "mistral-medium-latest",
        fallbackModel,
        apiKey: apiKey ?? process.env.MISTRAL_API_KEY,
      }
    case "openai":
      return {
        provider: "openai",
        model: model ?? "gpt-4o-mini",
        fallbackModel,
        apiKey: apiKey ?? process.env.OPENAI_API_KEY,
      }
    case "openrouter":
      return {
        provider: "openrouter",
        model: model ?? "anthropic/claude-sonnet-4",
        fallbackModel,
        apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
      }
    case "anthropic":
    case "claude":
    default:
      return {
        provider: "claude",
        model,
        fallbackModel,
        apiKey,
      }
  }
}

const init = new InitModule(
  process.env.CLEANSLICE_AGENT_DIR ?? ".agent",
  ".agent.example",
)

const toolGateway = new ToolGateway()

// MCP loader — connects to MCP servers from two sources:
//   1. agent.config.json `mcps` — local / dev-time entries
//   2. MCP_SERVERS_B64 env var (base64 of a JSON array) — populated by the
//      deploy pipeline of whatever platform hosts the runtime (Ranch, custom
//      k8s, compose…). Base64 because that pipeline injects the value into a
//      YAML manifest (see ranch/k8s/templates/agent-workflow.yaml).
// The runtime never talks to a specific platform's API directly. Tools are
// merged into the global list passed to AgentRuntime below.
const mcp = new McpModule()
const mcpServersJson = process.env.MCP_SERVERS_B64
  ? Buffer.from(process.env.MCP_SERVERS_B64, "base64").toString("utf8")
  : undefined
const mcpTools = await mcp.loadAll({
  fromConfig: init.config.mcps ?? [],
  fromEnv: mcpServersJson,
})

// Canonical agent-facing contract:
//   LLM_PROVIDER, LLM_MODEL, LLM_FALLBACK_MODEL, LLM_API_KEY
// For Anthropic, LLM_API_KEY accepts comma-separated OAuth tokens and/or
// a mixed OAuth+apiKey list — each token is auto-classified by its
// "sk-ant-oat" prefix inside ClaudeRepository.
// Provider-specific env vars (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, ...,
// CLAUDE_CODE_OAUTH_TOKEN) remain as legacy fallbacks.
const llm = buildLlmConfig(
  process.env.LLM_PROVIDER,
  process.env.LLM_MODEL,
  process.env.LLM_FALLBACK_MODEL,
  process.env.LLM_API_KEY,
)
// Auxiliary LLM for background work (compaction, summarization, future
// curator/insights). Resolution rules:
//   - If LLM_AUX_* env vars are set, build a standalone aux config.
//   - If only LLM_AUX_MODEL is set, inherit provider/key from main but use
//     the smaller model.
//   - Otherwise no aux is configured and aux calls fall back to main.
const llmAuxiliary = (process.env.LLM_AUX_PROVIDER || process.env.LLM_AUX_MODEL || process.env.LLM_AUX_API_KEY)
  ? buildLlmConfig(
    process.env.LLM_AUX_PROVIDER ?? process.env.LLM_PROVIDER,
    process.env.LLM_AUX_MODEL,
    process.env.LLM_AUX_FALLBACK_MODEL,
    process.env.LLM_AUX_API_KEY ?? process.env.LLM_API_KEY,
  )
  : undefined
if (llmAuxiliary) {
  console.log(`[llm] auxiliary: ${llmAuxiliary.provider}/${"model" in llmAuxiliary ? llmAuxiliary.model ?? "default" : "default"}`)
}

const runtime = new AgentRuntime({
  init,
  agentDir: ".agent",
  llm,
  llmAuxiliary,
  channels: [
    { type: "telegram", token: process.env.TELEGRAM_BOT_TOKEN ?? "" },
    ...(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN ? [{
      type: "slack" as const,
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
    }] : []),
    ...(process.env.BRIDLE_URL ? [{
      type: "bridle" as const,
      apiUrl: process.env.BRIDLE_URL,
    }] : []),
  ],
  tools: [...toolGateway.getAll(), ...mcpTools],
})

await runtime.start()
console.log(`🤖 Agent runtime v${pkg.version} started`)
if (process.env.BRIDLE_URL) console.log(`[bridle] enabled → ${process.env.BRIDLE_URL}`)
else console.log("[bridle] disabled (BRIDLE_URL not set)")

// Graceful shutdown on SIGTERM (docker stop) and SIGINT (ctrl+c)
// Gives runtime time to push final S3 sync before exit
async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, stopping runtime...`)
  try {
    await runtime.stop()
    await mcp.shutdown()
    console.log("[shutdown] clean exit")
  } catch (err) {
    console.error("[shutdown] error during stop:", err)
  }
  process.exit(0)
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch(req) {
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CleanSlice Agent</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; color: #333; }
      h1 { font-size: 2rem; margin-bottom: 8px; }
      p { color: #666; margin-bottom: 24px; }
      a { display: inline-block; padding: 12px 28px; background: #0088cc; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; }
      a:hover { background: #0077b5; }
    </style>
  </head>
  <body>
    <h1>🤖 Agent is running</h1>
    <p>Talk to me on Telegram</p>
    <a href="https://t.me/${process.env.TELEGRAM_BOT_NAME ?? ""}">Open Chat</a>
  </body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    )
  },
})
console.log(`🌐 HTTP server listening on port ${process.env.PORT ?? 3000}`)
