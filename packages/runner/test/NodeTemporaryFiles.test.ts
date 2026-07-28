import { assert, describe, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { nodeTemporaryFiles } from "@llm4ts/runner/NodeTemporaryFiles"

describe("NodeTemporaryFiles", () => {
  it.effect("writes a scoped file and removes its private directory on release", () =>
    Effect.gen(function* () {
      const capturedPath = yield* Ref.make("")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const path = yield* nodeTemporaryFiles.write("llm4ts-test-", ".json", '{"ok":true}')
          yield* Ref.set(capturedPath, path)

          assert.isTrue(existsSync(path))
          assert.strictEqual(readFileSync(path, "utf8"), '{"ok":true}')
        })
      )

      assert.isFalse(existsSync(yield* Ref.get(capturedPath)))
    })
  )
})
