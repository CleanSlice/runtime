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

import { AgentRuntime } from "./runtime"
import { ToolGateway } from "./slices/tool/data/tool.gateway"
import { InitModule } from "./slices/init"

const init = new InitModule(
  process.env.CLEANSLICE_AGENT_DIR ?? ".agent",
  ".agent.example",
)

const toolGateway = new ToolGateway()

const runtime = new AgentRuntime({
  init,
  llm: { provider: "claude" },  // uses CLAUDE_CODE_OAUTH_TOKEN + beta header
  channels: [
    { type: "telegram", token: process.env.TELEGRAM_TOKEN ?? "" },
    ...(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN ? [{
      type: "slack" as const,
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
    }] : []),
  ],
  tools: toolGateway.getAll(),
})

await runtime.start()
console.log("🤖 Agent runtime started")

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
    <a href="https://t.me/dv_cleanslice_bot">Open Chat</a>
  </body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    )
  },
})
console.log(`🌐 HTTP server listening on port ${process.env.PORT ?? 3000}`)
