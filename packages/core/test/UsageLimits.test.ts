import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import { classifyUsageLimit, isGeminiQuota } from "@llm4ts/core/UsageLimits"

const now = DateTime.makeUnsafe("2026-06-04T12:27:00Z")

describe("UsageLimits", () => {
  it("parses a future Codex wall-clock reset today", () => {
    const error = classifyUsageLimit(
      "codex",
      "You've hit your usage limit. Upgrade to Pro ... try again at 2:38 PM.",
      now,
      "UTC"
    )

    assert.strictEqual(error?._tag, "UsageLimitError")
    if (error?._tag === "UsageLimitError") {
      assert.strictEqual(
        error.resetAt === undefined ? undefined : DateTime.formatIso(error.resetAt),
        "2026-06-04T14:38:00.000Z"
      )
      assert.strictEqual(error.provider, "codex")
    }
  })

  it("rolls an elapsed Codex wall-clock reset to tomorrow", () => {
    const error = classifyUsageLimit("codex", "usage limit ... try again at 11:00 AM.", now, "UTC")

    assert.strictEqual(error?._tag, "UsageLimitError")
    if (error?._tag === "UsageLimitError") {
      assert.strictEqual(
        error.resetAt === undefined ? undefined : DateTime.formatIso(error.resetAt),
        "2026-06-05T11:00:00.000Z"
      )
    }
  })

  it("honors the supplied IANA time zone for wall-clock resets", () => {
    const error = classifyUsageLimit(
      "codex",
      "usage limit ... try again at 2:38 PM.",
      now,
      "Europe/Rome"
    )

    assert.strictEqual(error?._tag, "UsageLimitError")
    if (error?._tag === "UsageLimitError") {
      assert.strictEqual(
        error.resetAt === undefined ? undefined : DateTime.formatIso(error.resetAt),
        "2026-06-04T12:38:00.000Z"
      )
    }
  })

  it("parses Claude wall-clock reset messages with hour-only times", () => {
    const error = classifyUsageLimit(
      "claude",
      "You have reached your usage limit; resets at 3 PM.",
      now,
      "UTC"
    )

    assert.strictEqual(error?._tag, "UsageLimitError")
    if (error?._tag === "UsageLimitError") {
      assert.strictEqual(
        error.resetAt === undefined ? undefined : DateTime.formatIso(error.resetAt),
        "2026-06-04T15:00:00.000Z"
      )
    }
  })

  it("classifies short Gemini resets as transient rate limits", () => {
    const twoSeconds = classifyUsageLimit(
      "gemini",
      "You have exhausted your capacity. Your quota will reset after 2s.",
      now,
      "UTC"
    )
    const ninetySeconds = classifyUsageLimit(
      "gemini",
      "Your quota will reset after 90s.",
      now,
      "UTC"
    )
    const milliseconds = classifyUsageLimit(
      "gemini",
      "Your quota will reset after 500ms.",
      now,
      "UTC"
    )

    assert.strictEqual(twoSeconds?._tag, "RateLimitError")
    assert.strictEqual(ninetySeconds?._tag, "RateLimitError")
    assert.strictEqual(milliseconds?._tag, "RateLimitError")
    if (twoSeconds?._tag === "RateLimitError") {
      assert.strictEqual(Duration.toMillis(twoSeconds.retryAfter ?? Duration.zero), 2_000)
    }
    if (ninetySeconds?._tag === "RateLimitError") {
      assert.strictEqual(Duration.toMillis(ninetySeconds.retryAfter ?? Duration.zero), 90_000)
    }
    if (milliseconds?._tag === "RateLimitError") {
      assert.strictEqual(Duration.toMillis(milliseconds.retryAfter ?? Duration.zero), 500)
    }
  })

  it("classifies composite Gemini quota windows with a concrete reset", () => {
    const text =
      "TerminalQuotaError: You have exhausted your capacity on this model. " +
      "Your quota will reset after 21h1m53s."
    const error = classifyUsageLimit("gemini", text, now, "UTC")

    assert.strictEqual(error?._tag, "UsageLimitError")
    if (error?._tag === "UsageLimitError") {
      assert.strictEqual(
        error.resetAt === undefined ? undefined : DateTime.formatIso(error.resetAt),
        "2026-06-05T09:28:53.000Z"
      )
      assert.strictEqual(error.message, text)
    }
  })

  it("treats a 45-minute Gemini reset as a quota window", () => {
    const error = classifyUsageLimit("gemini", "Your quota will reset after 45m.", now, "UTC")

    assert.strictEqual(error?._tag, "UsageLimitError")
    if (error?._tag === "UsageLimitError") {
      assert.strictEqual(
        error.resetAt === undefined ? undefined : DateTime.formatIso(error.resetAt),
        "2026-06-04T13:12:00.000Z"
      )
    }
  })

  it("classifies Gemini quota signals without inventing a reset time", () => {
    const capacity = classifyUsageLimit(
      "gemini",
      "You have exhausted your capacity on this model.",
      now,
      "UTC"
    )
    const quota = classifyUsageLimit("gemini", "Quota exceeded for this project.", now, "UTC")
    const resource = classifyUsageLimit(
      "gemini",
      "Gemini CLI stream error (type=RESOURCE_EXHAUSTED, code=429): rate_limit reached",
      now,
      "UTC"
    )

    for (const error of [capacity, quota, resource]) {
      assert.strictEqual(error?._tag, "UsageLimitError")
      if (error?._tag === "UsageLimitError") {
        assert.strictEqual(error.resetAt, undefined)
      }
    }
  })

  it("leaves Gemini's ambiguous unknown error unclassified", () => {
    assert.isFalse(isGeminiQuota("API Error: An unknown error occurred."))
    assert.strictEqual(
      classifyUsageLimit("gemini", "API Error: An unknown error occurred.", now, "UTC"),
      undefined
    )
  })

  it("classifies generic quota signals for CLI providers", () => {
    for (const provider of ["grok", "cursor", "opencode"]) {
      const error = classifyUsageLimit(
        provider,
        "Error: 429 Too Many Requests — rate limit exceeded",
        now,
        "UTC"
      )
      assert.strictEqual(error?._tag, "UsageLimitError")
      if (error?._tag === "UsageLimitError") {
        assert.strictEqual(error.provider, provider)
        assert.strictEqual(error.resetAt, undefined)
      }
    }

    assert.strictEqual(
      classifyUsageLimit("grok", "Your team has run out of credits.", now, "UTC")?._tag,
      "UsageLimitError"
    )
    assert.strictEqual(
      classifyUsageLimit("cursor", "You have hit your usage limit.", now, "UTC")?._tag,
      "UsageLimitError"
    )
  })

  it("does not classify unrelated or unsupported-provider failures", () => {
    assert.strictEqual(classifyUsageLimit("codex", "some unrelated failure", now, "UTC"), undefined)
    assert.strictEqual(
      classifyUsageLimit("cursor", "some unrelated failure", now, "UTC"),
      undefined
    )
    assert.strictEqual(classifyUsageLimit("openai", "429 Too Many Requests", now, "UTC"), undefined)
  })
})
