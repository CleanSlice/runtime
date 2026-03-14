/**
 * Claude Code HTTP Proxy
 * Anthropic-compatible API that routes through claude CLI binary.
 * Enables OAuth + native tool calling without direct API key.
 */

const PORT = 19876

type ContentBlock = { type: string; text?: string; tool_use_id?: string; content?: string; name?: string; input?: unknown; id?: string }
type Message = { role: string; content: string | ContentBlock[] }
type Tool = { name: string; description: string; input_schema: Record<string, unknown> }

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (!req.url.includes("/messages")) return new Response("Not found", { status: 404 })

    const body = await req.json() as {
      model?: string
      system?: string
      messages: Message[]
      tools?: Tool[]
      max_tokens?: number
    }

    const systemPrompt = body.system ?? ""

    // Build conversation
    const conversation = body.messages.map(m => {
      let content: string
      if (Array.isArray(m.content)) {
        content = m.content.map(c => {
          if (c.type === "text") return c.text ?? ""
          if (c.type === "tool_result") return `[Tool result: ${JSON.stringify(c.content)}]`
          return JSON.stringify(c)
        }).join("\n")
      } else {
        content = m.content as string
      }
      return `${m.role === "user" ? "Human" : "Assistant"}: ${content}`
    }).join("\n\n")

    // Tool instructions — critical for reliable tool calling
    let toolsSection = ""
    if (body.tools?.length) {
      const toolDefs = body.tools.map(t =>
        `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.input_schema)}`
      ).join("\n\n")

      toolsSection = `

## TOOLS
You have access to these tools. When you need to call a tool, you MUST respond with ONLY this JSON (nothing else before or after):
{"type":"tool_use","name":"<tool_name>","input":{<params>}}

${toolDefs}

If no tool is needed, respond normally.`
    }

    const fullPrompt = [systemPrompt + toolsSection, "", conversation].filter(Boolean).join("\n\n")

    const proc = Bun.spawn([
      "/home/dmitriyzhuk/.local/bin/claude",
      "--print",
      "--permission-mode", "bypassPermissions",
      "--model", body.model ?? "claude-sonnet-4-6",
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    proc.stdin.write(fullPrompt)
    proc.stdin.end()

    const stdout = await new Response(proc.stdout).text()
    await proc.exited

    const text = stdout.trim()

    // Detect tool call — must be a JSON object starting with {"type":"tool_use"...}
    const jsonMatch = text.match(/^\s*(\{[\s\S]*\})\s*$/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as { type?: string; name?: string; input?: unknown }
        if (parsed.type === "tool_use" && parsed.name) {
          return Response.json({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [{
              type: "tool_use",
              id: `toolu_${Date.now()}`,
              name: parsed.name,
              input: parsed.input ?? {},
            }],
            stop_reason: "tool_use",
            model: body.model ?? "claude-sonnet-4-6",
            usage: { input_tokens: 0, output_tokens: 0 },
          })
        }
      } catch {}
    }

    return Response.json({
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      model: body.model ?? "claude-sonnet-4-6",
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  },
})

console.log(`Claude proxy running on http://localhost:${PORT}`)
