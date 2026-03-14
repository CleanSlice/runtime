import { AgentRuntime } from "./runtime"

const runtime = new AgentRuntime({
  agentDir: ".agent",
  llm: { provider: "claude", apiKey: process.env.ANTHROPIC_API_KEY },
  channels: [
    { type: "telegram", token: process.env.TELEGRAM_TOKEN ?? "" },
  ],
})

await runtime.start()
console.log("🤖 Agent runtime started")
