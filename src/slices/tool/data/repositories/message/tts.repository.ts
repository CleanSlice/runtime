import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { randomUUID } from "crypto"

const ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM" // Rachel

const schema = z.object({
  text: z.string().describe("Text to convert to speech"),
  chat_id: z.string().optional().describe("Telegram chat ID to send voice message to (defaults to ctx.from)"),
})

async function generateWithElevenLabs(text: string, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ElevenLabs API error: ${res.status} ${err}`)
  }

  return res.arrayBuffer()
}

async function generateWithEspeak(text: string, outPath: string): Promise<void> {
  // espeak to wav, then convert to ogg opus for Telegram
  const wavPath = outPath.replace(".ogg", ".wav")

  const espeakProc = Bun.spawn(["espeak", text, "-w", wavPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await espeakProc.exited
  if (exitCode !== 0) {
    throw new Error("espeak failed")
  }

  // Convert wav to ogg using ffmpeg or avconv
  const ffmpegProc = Bun.spawn(["ffmpeg", "-y", "-i", wavPath, "-c:a", "libopus", outPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await ffmpegProc.exited

  await Bun.spawn(["rm", "-f", wavPath]).exited
}

export const TtsTool: Tool = {
  name: "tts",
  description: "Convert text to speech and send as voice message to Telegram.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { text, chat_id } = schema.parse(params)

    const token = process.env.TELEGRAM_TOKEN
    if (!token) {
      return { error: "TELEGRAM_TOKEN environment variable is not set" }
    }

    const targetChatId = chat_id ?? ctx.from
    if (!targetChatId) {
      return { error: "No chat_id provided and ctx.from is not set" }
    }

    const tmpPath = `/tmp/tts-${randomUUID()}.ogg`
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY

    try {
      if (elevenLabsKey) {
        // Use ElevenLabs
        const audioBuffer = await generateWithElevenLabs(text, elevenLabsKey)
        await Bun.write(tmpPath, audioBuffer)
      } else {
        // Fallback: espeak
        await generateWithEspeak(text, tmpPath)
      }

      const audioFile = Bun.file(tmpPath)
      const exists = await audioFile.exists()
      if (!exists) {
        return { error: "TTS generation failed — audio file not created" }
      }

      // Send via Telegram sendVoice
      const form = new FormData()
      form.append("chat_id", targetChatId)
      form.append("voice", new Blob([await audioFile.arrayBuffer()], { type: "audio/ogg" }), "voice.ogg")

      const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      })

      const data = await res.json() as { ok: boolean; description?: string }

      if (!data.ok) {
        return { error: `Telegram sendVoice failed: ${data.description}` }
      }

      return { ok: true, sent: true, chat_id: targetChatId, provider: elevenLabsKey ? "elevenlabs" : "espeak" }
    } finally {
      await Bun.spawn(["rm", "-f", tmpPath]).exited
    }
  },
}
