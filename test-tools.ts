import { readFileSync } from "fs"
const lines = readFileSync(".env", "utf-8").split("\n")
for (const line of lines) {
  const [key, ...rest] = line.split("=")
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim()
}

import { ToolGateway } from "./src/slices/tool/data/tool.gateway"

const gateway = new ToolGateway()
const ctx = { sessionId: "test", agentDir: ".agent", send: async (t: string) => console.log("SEND:", t) }

console.log("=== Testing exec tool ===")
const execResult = await gateway.execute("exec", { command: "echo hello && date" }, ctx)
console.log("exec:", JSON.stringify(execResult))

console.log("\n=== Testing cron_list ===")
const cronList = await gateway.execute("cron_list", {}, ctx)
console.log("cron_list:", JSON.stringify(cronList))

console.log("\n=== Testing cron_add ===")
const cronAdd = await gateway.execute("cron_add", {
  name: "test-tick",
  schedule: "* * * * *",
  message: "send current time to user",
  to: "55212224",
  channel: "telegram"
}, ctx)
console.log("cron_add:", JSON.stringify(cronAdd))

console.log("\n=== Verify cron saved ===")
const cronList2 = await gateway.execute("cron_list", {}, ctx)
console.log("after add:", JSON.stringify(cronList2))
