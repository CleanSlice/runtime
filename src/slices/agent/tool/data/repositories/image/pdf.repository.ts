import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"

const schema = z.object({
  url: z.string().url().describe("URL of the PDF document to analyze"),
  prompt: z.string().optional().default("Summarize this PDF").describe("What to ask about the PDF"),
})

async function extractPdfText(pdfPath: string): Promise<string> {
  // Try pdftotext (poppler) first — lightweight and fast
  const proc = Bun.spawn(["pdftotext", pdfPath, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [text, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode === 0 && text.trim().length > 0) {
    return text.trim()
  }

  // Fallback: try strings command to extract raw text
  const stringsProc = Bun.spawn(["strings", pdfPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stringsOut] = await Promise.all([
    new Response(stringsProc.stdout).text(),
    stringsProc.exited,
  ])

  return stringsOut
    .split("\n")
    .filter(line => line.length > 3 && /[a-zA-Z]/.test(line))
    .join("\n")
    .trim()
}

export const PdfAnalyzeTool: Tool = {
  name: "pdf_analyze",
  description: "Analyze a PDF document from a URL. Extracts text and answers questions about it.",
  schema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { url, prompt } = schema.parse(params)

    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (!oauthToken) {
      return { error: "CLAUDE_CODE_OAUTH_TOKEN environment variable is not set" }
    }

    // Download PDF to temp file
    const tmpPath = `/tmp/pdf-${randomUUID()}.pdf`
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CleansliceBot/1.0)" },
    })

    if (!res.ok) {
      return { error: `Failed to download PDF: ${res.status} ${res.statusText}` }
    }

    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) {
      return { error: `URL does not appear to be a PDF (content-type: ${contentType})` }
    }

    const buffer = await res.arrayBuffer()
    await Bun.write(tmpPath, buffer)

    let pdfText: string
    try {
      pdfText = await extractPdfText(tmpPath)
    } finally {
      await Bun.spawn(["rm", "-f", tmpPath]).exited
    }

    if (!pdfText || pdfText.length < 10) {
      return { error: "Could not extract text from PDF. The file may be scanned/image-based." }
    }

    // Trim to avoid token overflow (keep first 30k chars)
    const textToAnalyze = pdfText.slice(0, 30000)

    // Send to Claude for analysis
    const claudeBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Here is the extracted text from a PDF document:\n\n${textToAnalyze}\n\n---\n\n${prompt}`,
        },
      ],
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${oauthToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify(claudeBody),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      return { error: `Anthropic API error: ${claudeRes.status} ${errText}` }
    }

    const data = await claudeRes.json() as { content?: Array<{ type: string; text?: string }> }
    const analysis = data?.content?.find(c => c.type === "text")?.text ?? ""

    return {
      url,
      analysis,
      extractedChars: pdfText.length,
    }
  },
}
