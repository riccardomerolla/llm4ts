import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, type Message } from "@llm4ts/core/Models"
import { makeChat } from "@llm4ts/flow/Chat"

const unused = InvalidRequestError.make({ message: "unused" })

const recordingService = (
  calls: Ref.Ref<ReadonlyArray<ReadonlyArray<Message>>>,
  reply = "ok"
): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (messages) =>
    Stream.fromEffect(
      Ref.update(calls, (recorded) => [...recorded, messages]).pipe(
        Effect.as(LlmChunk.make({ delta: reply, finishReason: "stop" }))
      )
    ),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

describe("Chat", () => {
  it.effect("threads successful turns through accumulated history", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
      const chat = yield* makeChat(recordingService(calls), { manageGit: true })

      assert.strictEqual(yield* chat.ask("first"), "ok")
      assert.strictEqual(yield* chat.ask("second"), "ok")

      const seen = yield* Ref.get(calls)
      const messages = yield* chat.messages
      assert.strictEqual(seen.length, 2)
      assert.deepStrictEqual(
        seen[1]?.map((message) => message.role),
        ["User", "Assistant", "User"]
      )
      assert.deepStrictEqual(
        messages.map((message) => message.role),
        ["User", "Assistant", "User", "Assistant"]
      )
    })
  )

  it.effect("seeds the system policy and leaves history unchanged after failure", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
      const service: LlmServiceShape = {
        ...recordingService(calls),
        executeStreamWithHistory: (_messages) =>
          Stream.fail(ProviderError.make({ message: "boom" }))
      }
      const chat = yield* makeChat(service, { system: "Be terse." })
      const before = yield* chat.messages
      const result = yield* Effect.result(chat.ask("hello"))
      const after = yield* chat.messages

      assert.strictEqual(before[0]?.role, "System")
      assert.include(before[0]?.content ?? "", "runtime owns git")
      assert.include(before[0]?.content ?? "", "Be terse.")
      assert.strictEqual(result._tag, "Failure")
      assert.deepStrictEqual(after, before)
    })
  )

  it.effect("serializes concurrent asks so turns cannot interleave", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const service: LlmServiceShape = {
        ...recordingService(calls),
        executeStreamWithHistory: (messages) =>
          Stream.fromEffect(
            Ref.update(calls, (recorded) => [...recorded, messages]).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(LlmChunk.make({ delta: "ok", finishReason: "stop" }))
            )
          )
      }
      const chat = yield* makeChat(service, { manageGit: true })
      const first = yield* Effect.forkChild(chat.ask("one"))
      yield* Deferred.await(entered)
      const second = yield* Effect.forkChild(chat.ask("two"))
      yield* Effect.yieldNow

      assert.strictEqual((yield* Ref.get(calls)).length, 1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      const sizes = (yield* Ref.get(calls)).map((messages) => messages.length)
      assert.deepStrictEqual(sizes, [1, 3])
    })
  )
})
