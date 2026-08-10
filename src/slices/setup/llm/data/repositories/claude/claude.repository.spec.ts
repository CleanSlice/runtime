import { describe, expect, test } from "bun:test"
import {
  EXTENDED_CACHE_TTL_BETA,
  buildApiKeyBetaHeader,
  buildOauthBetaHeader,
  buildSystemParam,
} from "./claude.repository"

describe("buildSystemParam", () => {
  test("wraps the prompt in a single cache-marked text block with 1h TTL", () => {
    const param = buildSystemParam("You are a helpful agent.")

    expect(param).toEqual([
      {
        type: "text",
        text: "You are a helpful agent.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ])
  })

  test("preserves prompt bytes exactly (prefix stability is the cache key)", () => {
    const prompt = "line1\n\n  indented\nюникод ✓\t"
    expect(buildSystemParam(prompt)[0].text).toBe(prompt)
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
