import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { Info, StageCompleted, StageStarted, makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"

const memoryFiles = (contents: Ref.Ref<Readonly<Record<string, string>>>): PlainFileStoreShape => ({
  read: (path) => Ref.get(contents).pipe(Effect.map((files) => files[path])),
  writeAtomic: (path, value) => Ref.update(contents, (files) => ({ ...files, [path]: value })),
  append: (path, value) =>
    Ref.update(contents, (files) => ({
      ...files,
      [path]: `${files[path] ?? ""}${value}`
    })),
  remove: (path) =>
    Ref.update(contents, (files) =>
      Object.fromEntries(Object.entries(files).filter(([candidate]) => candidate !== path))
    ),
  hashSha256: (_path) => Effect.succeed("digest")
})

describe("FlowRecorder", () => {
  it.effect("serializes high- and low-level signals in monotonic order", () =>
    Effect.gen(function* () {
      const contents = yield* Ref.make<Readonly<Record<string, string>>>({})
      const recorder = yield* makeFlowRecorder(memoryFiles(contents), "trace.jsonl", "run-1")
      yield* recorder.record(StageStarted.make({ stage: "plan" }))
      yield* recorder.rawLine("gemini-cli", "model", '{"type":"message"}')
      yield* recorder.streamError("gemini-cli", undefined, "empty")
      const lines = (yield* Ref.get(contents))["trace.jsonl"]?.trim().split("\n")

      assert.strictEqual(lines?.length, 3)
      assert.match(lines?.[0] ?? "", /"seq":0/)
      assert.match(lines?.[0] ?? "", /"kind":"StageStarted"/)
      assert.match(lines?.[1] ?? "", /"seq":1/)
      assert.match(lines?.[2] ?? "", /"kind":"StreamError"/)
    })
  )

  it.effect("subscribes before returning and records hub events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contents = yield* Ref.make<Readonly<Record<string, string>>>({})
        const recorder = yield* makeFlowRecorder(memoryFiles(contents), "trace.jsonl", "run-2")
        const hub = yield* makeFlowEventHub()
        yield* recorder.consume(hub)
        yield* hub.publish(StageStarted.make({ stage: "build" }))
        yield* hub.publish(StageCompleted.make({ stage: "build" }))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const trace = (yield* Ref.get(contents))["trace.jsonl"] ?? ""

        assert.match(trace, /StageStarted/)
        assert.match(trace, /StageCompleted/)
        assert.strictEqual(yield* hub.publishedCount, 2)
      })
    )
  )

  it.effect("degrades permanently after a write failure without failing the flow", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failing: PlainFileStoreShape = {
        read: (_path) => Effect.succeed(undefined),
        writeAtomic: (_path, _value) => Effect.void,
        append: (_path, _value) =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(
                PersistenceError.make({
                  message: "disk unavailable"
                })
              )
            )
          ),
        remove: (_path) => Effect.void,
        hashSha256: (_path) => Effect.succeed("")
      }
      const recorder = yield* makeFlowRecorder(failing, "trace.jsonl", "run-3")
      yield* recorder.record(Info.make({ message: "first" }))
      yield* recorder.record(Info.make({ message: "second" }))

      assert.strictEqual(yield* Ref.get(attempts), 1)
    })
  )
})
