import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ChiefAction, ChiefContext, failedReply } from "@llm4ts/flow/ChiefAction"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { ScriptUsage } from "@llm4ts/runner"
import { loadChiefContext, runChief } from "../lib/chief.ts"
import { scripted } from "./support.ts"

const actionPath = "/repo/.llm4ts/chat/space-1/actions/msg-1.json"

const context = ChiefContext.make({
  messageName: "spaces/space-1/messages/msg-1",
  actionPath,
  request: { text: "/bot implement the login page", sender: "users/42" },
  flows: [{ name: "implement", description: "Plan, code, review and commit a task." }],
  runs: [],
  recent: []
})

const writtenAction = (files: Effect.Effect<Readonly<Record<string, string>>>) =>
  Effect.gen(function* () {
    const text = (yield* files)[actionPath]
    assert.isDefined(text)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChiefAction))(text ?? "")
  })

describe("runChief", () => {
  it.effect("writes a valid proposal to actionPath and returns it", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const seat = yield* scripted([
        { action: "start_run", reply: "Starting.", flow: "implement", task: "the login page" }
      ])
      const action = yield* runChief({
        files: memory.store,
        events,
        seat: seat.service,
        context
      })
      const expected: ChiefAction = {
        _tag: "StartRun",
        flow: "implement",
        task: "the login page",
        reply: "Starting."
      }
      assert.deepStrictEqual(action, expected)
      assert.deepStrictEqual(yield* writtenAction(memory.files), expected)
      assert.strictEqual(yield* seat.calls, 1)
    })
  )

  it.effect("retries an invalid proposal once, naming the violation", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const seat = yield* scripted([
        { action: "start_run", reply: "Starting.", flow: "deploy", task: "ship it" },
        { action: "answer", reply: "I can only run implement." }
      ])
      const action = yield* runChief({ files: memory.store, events, seat: seat.service, context })
      assert.deepStrictEqual(action, { _tag: "Answer", reply: "I can only run implement." })
      const prompts = yield* seat.prompts
      assert.strictEqual(prompts.length, 2)
      assert.notInclude(prompts[0] ?? "", "previous proposal was invalid")
      assert.include(prompts[1] ?? "", 'The flow "deploy" is not allowed')
    })
  )

  it.effect("two invalid proposals write Failed with the fixed reply", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const seat = yield* scripted([
        { action: "answer", reply: "" },
        { action: "stop_run", reply: "Stopping.", runId: "run-unknown" }
      ])
      const action = yield* runChief({ files: memory.store, events, seat: seat.service, context })
      const expected: ChiefAction = { _tag: "Failed", reply: failedReply }
      assert.deepStrictEqual(action, expected)
      assert.deepStrictEqual(yield* writtenAction(memory.files), expected)
      assert.strictEqual(yield* seat.calls, 2)
    })
  )

  it.effect("a seat failure writes Failed", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const working = yield* scripted([])
      const seat: LlmServiceShape = {
        ...working.service,
        executeStructuredWithUsage: () => Effect.fail(ProviderError.make({ message: "seat down" }))
      }
      const action = yield* runChief({ files: memory.store, events, seat, context })
      const expected: ChiefAction = { _tag: "Failed", reply: failedReply }
      assert.deepStrictEqual(action, expected)
      assert.deepStrictEqual(yield* writtenAction(memory.files), expected)
    })
  )
})

describe("loadChiefContext", () => {
  const contextPath = "/repo/.llm4ts/chat/space-1/requests/msg-1.json"

  it.effect("decodes the context file the task names", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({
        [contextPath]: JSON.stringify(Schema.encodeSync(ChiefContext)(context))
      })
      const loaded = yield* loadChiefContext(memory.store, contextPath)
      assert.deepStrictEqual(loaded, context)
    })
  )

  it.effect("fails with ScriptUsage on a missing file", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const failure = yield* loadChiefContext(memory.store, contextPath).pipe(Effect.flip)
      assert.instanceOf(failure, ScriptUsage)
      assert.include(failure.message, contextPath)
    })
  )

  it.effect("fails with ScriptUsage on JSON that is not a ChiefContext", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({
        [contextPath]: JSON.stringify({ messageName: "m" })
      })
      const failure = yield* loadChiefContext(memory.store, contextPath).pipe(Effect.flip)
      assert.instanceOf(failure, ScriptUsage)
      assert.include(failure.message, contextPath)
    })
  )
})
