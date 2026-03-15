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

const toolGateway = new ToolGateway()

const runtime = new AgentRuntime({
  agentDir: ".agent",
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
