import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { redactText, sanitizeFields } from "@llm4ts/core/observability/Redaction"
import {
  currentStreamRecorder,
  noopStreamRecorder,
  withStreamRecorder
} from "@llm4ts/core/observability/StreamRecorder"

describe("redaction", () => {
  it("redacts known and patterned secrets and bounds payloads", () => {
    assert.strictEqual(redactText("token=known", { secrets: ["known"] }), "token=[REDACTED]")
    assert.deepStrictEqual(
      sanitizeFields({
        apiKey: "secret",
        safe: { token: "secret", value: "ok" }
      }),
      {
        apiKey: "[REDACTED]",
        safe: { token: "[REDACTED]", value: "ok" }
      }
    )
    assert.match(redactText("123456", { maxLength: 3 }), /TRUNCATED/)
  })
})

describe("ambient stream recorder", () => {
  it.effect("defaults to noop and supports a fiber-local override", () =>
    Effect.gen(function* () {
      const before = yield* currentStreamRecorder
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      const recorder = {
        rawLine: (_provider: string, _model: string | undefined, line: string) =>
          Ref.update(lines, (current) => [...current, line]),
        streamError: (_provider: string, _model: string | undefined, message: string) =>
          Ref.update(lines, (current) => [...current, message])
      }

      yield* withStreamRecorder(recorder)(
        Effect.gen(function* () {
          const current = yield* currentStreamRecorder
          yield* current.rawLine("gemini-cli", "m", "raw")
          yield* current.streamError("gemini-cli", undefined, "boom")
        })
      )

      assert.strictEqual(before, noopStreamRecorder)
      assert.deepStrictEqual(yield* Ref.get(lines), ["raw", "boom"])
      assert.strictEqual(yield* currentStreamRecorder, noopStreamRecorder)
    })
  )
})
