import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  jsonArray,
  jsonBooleanField,
  jsonField,
  jsonIntField,
  jsonObjectEntries,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  usageEventChunk
} from "@llm4ts/core/providers/CliSupport"

describe("CliSupport", () => {
  it.effect("parses JSON object lines and ignores diagnostics", () =>
    Effect.gen(function* () {
      const parsed = parseJsonLine('{"text":"hello","count":2.8,"ok":true,"items":[1,2]}')

      assert.strictEqual(
        parsed === undefined ? undefined : jsonStringField(parsed, "text"),
        "hello"
      )
      assert.strictEqual(parsed === undefined ? undefined : jsonIntField(parsed, "count"), 2)
      assert.strictEqual(parsed === undefined ? undefined : jsonBooleanField(parsed, "ok"), true)
      assert.strictEqual(
        jsonArray(parsed === undefined ? undefined : jsonField(parsed, "items")).length,
        2
      )
      assert.strictEqual(parseJsonLine("warning: retrying"), undefined)
      assert.strictEqual(parseJsonLine("{broken"), undefined)
    })
  )

  it.effect("builds deterministic model and passthrough flags", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(optionalModelArgs("model"), ["--model", "model"])
      assert.deepStrictEqual(optionalModelArgs(undefined), [])
      assert.deepStrictEqual(
        sortedFlagArgs({
          verbose: "",
          sandbox: "read-only",
          alpha: "one"
        }),
        ["--alpha", "one", "--sandbox", "read-only", "--verbose"]
      )
    })
  )

  it.effect("normalizes tool and terminal usage chunks", () =>
    Effect.gen(function* () {
      const parsed = parseJsonLine('{"name":"read","args":{"path":"README.md"}}')
      const tool = toolEventChunk(
        parsed === undefined ? "" : (jsonStringField(parsed, "name") ?? ""),
        parsed === undefined ? undefined : jsonField(parsed, "args")
      )
      const usage = usageEventChunk(
        "model",
        TokenUsage.make({
          prompt: 3,
          completion: 2,
          total: 5
        })
      )

      assert.strictEqual(tool.metadata.event, "tool_use")
      assert.strictEqual(tool.metadata.tool_name, "read")
      assert.match(tool.metadata.tool_input ?? "", /README/)
      assert.strictEqual(usage.finishReason, "stop")
      assert.strictEqual(usage.usage?.total, 5)
      assert.strictEqual(usage.metadata.model, "model")
      assert.strictEqual(jsonObjectEntries(parsed === undefined ? undefined : parsed).length, 2)
    })
  )
})
