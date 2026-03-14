// Load .env file
import { readFileSync, existsSync } from "fs"
if (existsSync(".env")) {
  const lines = readFileSync(".env", "utf-8").split("\n")
  for (const line of lines) {
    const [key, ...rest] = line.split("=")
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim()
  }
}

import { AgentRuntime } from "./runtime"
import { ToolGateway } from "./slices/tool/data/tool.gateway"

const toolGateway = new ToolGateway()

const runtime = new AgentRuntime({
  agentDir: ".agent",
  llm: { provider: "claude-cli" },
  channels: [
    { type: "telegram", token: process.env.TELEGRAM_TOKEN ?? "" },
  ],
  tools: toolGateway.getAll(),
})

await runtime.start()
console.log("🤖 Agent runtime started")
