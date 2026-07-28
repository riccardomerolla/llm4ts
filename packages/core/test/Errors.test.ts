import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  AuthenticationError,
  ConfigError,
  InvalidRequestError,
  LlmError,
  ParseError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ToolError,
  TurnLimitError,
  UsageLimitError
} from "@llm4ts/core/Errors"

describe("LlmError", () => {
  it("gives every source error variant a stable non-empty message", () => {
    const errors: ReadonlyArray<LlmError> = [
      new ProviderError({ message: "provider down" }),
      new AuthenticationError({ message: "bad key" }),
      new InvalidRequestError({ message: "nope" }),
      new ParseError({ message: "not json", raw: "<<<" }),
      new ToolError({ toolName: "Bash", detail: "exit 1" }),
      new ConfigError({ message: "missing model" }),
      new RateLimitError({ retryAfter: Duration.seconds(5) }),
      new TimeoutError({ duration: Duration.seconds(30) }),
      new TurnLimitError({ limit: 10 })
    ]

    assert.isTrue(errors.every((error) => error.message.length > 0))
    assert.match(errors[4].message, /Bash/)
    assert.match(errors[4].message, /exit 1/)
    assert.match(errors[6].message, /retry after/)
    assert.match(errors[8].message, /10/)
  })

  it("retains usage-limit reset time, provider, and message", () => {
    const resetAt = DateTime.makeUnsafe("2026-06-04T14:38:00Z")
    const error = new UsageLimitError({
      resetAt,
      provider: "codex",
      message: "You've hit your usage limit"
    })

    assert.deepStrictEqual(error.resetAt, resetAt)
    assert.strictEqual(error.provider, "codex")
    assert.strictEqual(error.message, "You've hit your usage limit")
  })

  it.effect("round-trips the tagged union through its JSON codec", () =>
    Effect.gen(function* () {
      const codec = Schema.toCodecJson(LlmError)
      const error = new RateLimitError({ retryAfter: Duration.seconds(5) })
      const encoded = yield* Schema.encodeEffect(codec)(error)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded)

      assert.strictEqual(decoded._tag, "RateLimitError")
      assert.strictEqual(decoded.message, "rate limited; retry after 5s")
    })
  )
})
