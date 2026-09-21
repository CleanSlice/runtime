import { describe, expect, mock, test } from "bun:test"
import {
  ClaudeRepository,
  EXTENDED_CACHE_TTL_BETA,
  billableInputTokens,
  buildApiKeyBetaHeader,
  buildOauthBetaHeader,
  buildSystemParam,
} from "./claude.repository"

describe("buildSystemParam", () => {
  test("API key: wraps the prompt in a single cache-marked text block with 1h TTL", () => {
    const param = buildSystemParam("You are a helpful agent.", { oauth: false })

    expect(param).toEqual([
      {
        type: "text",
        text: "You are a helpful agent.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ])
  })

  test("OAuth: the Claude Code identity line leads, the prompt carries the only breakpoint", () => {
    const param = buildSystemParam("You are a helpful agent.", { oauth: true })

    expect(param).toEqual([
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: "text",
        text: "You are a helpful agent.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ])
  })

  test("preserves prompt bytes exactly (prefix stability is the cache key)", () => {
    const prompt = "line1\n\n  indented\nюникод ✓\t"
    expect(buildSystemParam(prompt, { oauth: false }).at(-1)?.text).toBe(prompt)
    expect(buildSystemParam(prompt, { oauth: true }).at(-1)?.text).toBe(prompt)
  })
})

describe("system param per credential", () => {
  // Stand-in for the SDK: records what each client would put on the wire.
  const requests: Array<{ system: Array<{ text: string }> }> = []
  mock.module("@anthropic-ai/sdk", () => ({
    default: class {
      messages = {
        create: async (params: { system: Array<{ text: string }> }) => {
          requests.push({ system: params.system })
          return {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        },
      }
    },
  }))

  const systemTextsFor = async (apiKey: string): Promise<string[]> => {
    requests.length = 0
    const repo = new ClaudeRepository({ model: "claude-test", apiKey })
    await repo.complete("You are a helpful agent.", [], [])
    expect(requests).toHaveLength(1)
    return requests[0].system.map(b => b.text)
  }

  test("an OAuth token sends the identity line ahead of the prompt", async () => {
    expect(await systemTextsFor("sk-ant-oat01-test")).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "You are a helpful agent.",
    ])
  })

  test("an API key sends the prompt alone", async () => {
    expect(await systemTextsFor("sk-ant-api03-test")).toEqual(["You are a helpful agent."])
  })
})

describe("beta headers", () => {
  test("OAuth clients append the extended-cache-ttl flag to existing betas", () => {
    expect(buildOauthBetaHeader()).toBe(
      `oauth-2025-04-20,claude-code-20250219,${EXTENDED_CACHE_TTL_BETA}`
    )
  })

  test("API-key clients carry the extended-cache-ttl flag", () => {
    expect(buildApiKeyBetaHeader()).toBe(EXTENDED_CACHE_TTL_BETA)
  })

  test("beta flag is the documented extended-TTL identifier", () => {
    expect(EXTENDED_CACHE_TTL_BETA).toBe("extended-cache-ttl-2025-04-11")
  })
})

describe("billableInputTokens", () => {
  test("without cache activity equals raw input tokens (pre-caching behavior)", () => {
    expect(billableInputTokens({ input_tokens: 24_600, output_tokens: 105 })).toBe(24_600)
    expect(billableInputTokens({ input_tokens: 24_600, cache_creation_input_tokens: null, cache_read_input_tokens: null })).toBe(24_600)
  })

  test("cache reads fold in at 0.1× the input rate", () => {
    // Observed live: in=11, cache_read=8025 → 11 + 802.5 ≈ 814 billing-equivalent
    expect(billableInputTokens({ input_tokens: 11, cache_read_input_tokens: 8025 })).toBe(814)
  })

  test("1h-TTL cache writes fold in at 2× the input rate", () => {
    // Observed live: in=11, cache_write=8025 → 11 + 16050 = 16061
    expect(billableInputTokens({ input_tokens: 11, cache_creation_input_tokens: 8025 })).toBe(16_061)
  })

  test("mixed usage sums all three components", () => {
    expect(billableInputTokens({
      input_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 2000,
    })).toBe(100 + 100 + 4000)
  })

  test("missing or null fields are treated as zero", () => {
    expect(billableInputTokens({})).toBe(0)
    expect(billableInputTokens(undefined)).toBe(0)
    expect(billableInputTokens({ input_tokens: null, cache_read_input_tokens: 500 })).toBe(50)
  })
})
