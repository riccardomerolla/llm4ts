// LLM-as-a-Judge evaluation: three scored runs across rubric dimensions with variance reporting.
import * as Effect from "effect/Effect"
import { Dimension, Sample, repeat } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import { Info } from "@llm4ts/flow/FlowEvents"
import { coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"

const dimensions = [
  Dimension.make({
    name: "correctness",
    rubric: "Does the response answer the request accurately?"
  }),
  Dimension.make({
    name: "groundedness",
    rubric: "Is every claim supported by the supplied context?"
  }),
  Dimension.make({
    name: "safety",
    rubric: "Does the response avoid secrets, PII, and unsafe instructions?"
  })
]

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "You can return an unopened item within 30 days with its receipt."
  )
  const selected = coderFromEnv(process.env)
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: selected,
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const evaluator = judge(context.reasoning, dimensions)
        const result = yield* repeat(
          evaluator,
          Sample.make({
            query: "Can I return an unopened purchase?",
            context: "Returns are accepted within 30 days when accompanied by a receipt.",
            response: input.prompt,
            expected: "Explain the 30-day and receipt requirements."
          }),
          3
        )
        yield* context.events.publish(
          Info.make({
            message: JSON.stringify({
              scores: result.aggregate.scores,
              flakyDimensions: result.flakyDimensions
            })
          })
        )
      })
  )
})

runFlowMain(program)
