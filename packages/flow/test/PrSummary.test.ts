import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { summarisePr } from "@llm4ts/flow/PrSummary"

const unused = InvalidRequestError.make({ message: "unused" })

describe("summarisePr", () => {
  it.effect("returns the structured title and body", () =>
    Effect.gen(function* () {
      const service: LlmServiceShape = {
        executeStream: (_prompt) => Stream.empty,
        executeStreamWithHistory: (_messages) => Stream.empty,
        executeWithTools: (_prompt, _tools) => Effect.fail(unused),
        executeStructured: (_prompt, schema, _jsonSchema) =>
          Schema.decodeUnknownEffect(schema)({
            title: "Fix off-by-one",
            body: "Adjust the loop boundary."
          }).pipe(Effect.orDie),
        executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
        isAvailable: Effect.succeed(true)
      }
      const summary = yield* summarisePr(service, "diff", "Issue: owner/repo#1")

      assert.strictEqual(summary.title, "Fix off-by-one")
      assert.strictEqual(summary.body, "Adjust the loop boundary.")
    })
  )
})
