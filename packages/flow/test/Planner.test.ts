import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk } from "@llm4ts/core/Models"
import { assessThenPlan, briefPlan, planFrom, reviewPlan } from "@llm4ts/flow/Planner"
import { Plan, Task } from "@llm4ts/flow/Plan"

const unused = InvalidRequestError.make({ message: "unused" })

const structuredService = (value: unknown, prompt: Ref.Ref<string>): LlmServiceShape => ({
  executeStream: (_text) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_text, _tools) => Effect.fail(unused),
  executeStructured: (text, schema, _jsonSchema) =>
    Ref.set(prompt, text).pipe(
      Effect.andThen(Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie))
    ),
  executeStructuredWithUsage: (_text, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

const textService = (text: string): LlmServiceShape => ({
  ...structuredService({}, Ref.makeUnsafe("")),
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: text, finishReason: "stop" }))
})

describe("Planner", () => {
  it.effect("creates, reviews, and briefs plans with structured contracts", () =>
    Effect.gen(function* () {
      const prompt = yield* Ref.make("")
      const draft = yield* planFrom(
        structuredService(
          {
            epicId: "add-multiply",
            tasks: [
              {
                title: "Add multiply",
                description: "Implement and test multiplication",
                completed: false
              }
            ]
          },
          prompt
        ),
        "Add multiply"
      )
      const reviewed = yield* reviewPlan(
        structuredService(
          {
            epicId: "add-multiply",
            tasks: [
              {
                title: "Improve multiply",
                description: "Cover edge cases",
                completed: false
              }
            ]
          },
          prompt
        ),
        Plan.make({ ...draft, brief: "keep this" })
      )
      const briefed = yield* briefPlan(textService("  Modules: packages/core.  "), reviewed, "x")

      assert.strictEqual(draft.epicId, "add-multiply")
      assert.strictEqual(reviewed.tasks[0]?.title, "Improve multiply")
      assert.strictEqual(reviewed.brief, "keep this")
      assert.strictEqual(briefed.brief, "Modules: packages/core.")
      assert.include(yield* Ref.get(prompt), "Draft plan:")
    })
  )

  it.effect("returns both readiness verdicts", () =>
    Effect.gen(function* () {
      const prompt = yield* Ref.make("")
      const proceed = yield* assessThenPlan(
        structuredService(
          {
            kind: "Proceed",
            value: {
              epicId: "ready",
              tasks: []
            }
          },
          prompt
        ),
        "ready"
      )
      const blocked = yield* assessThenPlan(
        structuredService({ kind: "Blocked", reason: "needs design" }, prompt),
        "vague"
      )

      assert.strictEqual(proceed.kind, "Proceed")
      assert.strictEqual(proceed.kind === "Proceed" ? proceed.value.epicId : "", "ready")
      assert.strictEqual(blocked.kind, "Blocked")
      assert.strictEqual(blocked.kind === "Blocked" ? blocked.reason : "", "needs design")
    })
  )

  it.effect("maps provider failures into the flow error channel", () =>
    Effect.gen(function* () {
      const service: LlmServiceShape = {
        ...textService(""),
        executeStructured: (_prompt, _schema, _jsonSchema) =>
          Effect.fail(ProviderError.make({ message: "boom" }))
      }
      const result = yield* Effect.result(planFrom(service, "x"))

      assert.strictEqual(result._tag, "Failure")
      assert.strictEqual(result._tag === "Failure" ? result.failure._tag : "", "Llm")
    })
  )

  it("keeps Plan construction available to callers", () => {
    const plan = Plan.make({
      epicId: "x",
      tasks: [Task.make({ title: "t", description: "d" })]
    })
    assert.strictEqual(plan.nextIncomplete?.title, "t")
  })
})
