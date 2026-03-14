import { AgentRuntime } from "./runtime"

const runtime = new AgentRuntime({
  agentDir: ".agent",
  llm: { provider: "claude-cli" },
  channels: [
    { type: "telegram", token: process.env.TELEGRAM_TOKEN ?? "" },
  ],
})

await runtime.start()
console.log("🤖 Agent runtime started")
