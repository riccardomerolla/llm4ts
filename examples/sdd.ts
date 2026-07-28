import { join } from "node:path"
import * as Effect from "effect/Effect"
import { makeChat } from "@llm4ts/flow/Chat"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { Plan, defaultPlanPath } from "@llm4ts/flow/Plan"
import { implementTaskLoop, stage } from "@llm4ts/flow/PlanExecution"
import { defaultPlanInstructions, planFrom, writeBrief } from "@llm4ts/flow/Planner"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import {
  lintCommand,
  minimalReviewers,
  reviewAndFixLoop,
  type ReviewResult
} from "@llm4ts/flow/Review"
import { asReadOnly, coderFromEnv, gemini, withModel } from "@llm4ts/runner/Connectors"
import { runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { resolveExampleInput, runExampleMain } from "./support.ts"

const proModel = process.env.LLM4TS_REASONING_MODEL ?? "gemini-3-pro-preview"
const flashModel = process.env.LLM4TS_CODER_MODEL ?? "gemini-2.5-flash"

const specInstructions = [
  "Turn the change request into a precise repository specification with context, goals,",
  "non-goals, and a numbered list of testable Given/When/Then acceptance criteria.",
  "Explore the repository as needed. Return Markdown prose, not a task list."
].join("\n")

const planInstructions = [
  defaultPlanInstructions,
  "",
  "The request below is a specification with numbered acceptance criteria.",
  "The first task must encode those criteria as tests without changing production code.",
  "Every later task implements production behavior toward making those tests pass."
].join("\n")

const verificationFailure = (result: ReviewResult): FlowAborted =>
  FlowAborted.make({
    message: [
      "acceptance criteria not met:",
      ...result.issues.map((issue) => `${issue.title}\n${issue.description}`)
    ].join("\n\n")
  })

const program = Effect.gen(function* () {
  const input = yield* resolveExampleInput(
    "Add due dates, mark overdue items in list output, and show items due today."
  )
  const explicitCoder = process.env.LLM4TS_CODER?.trim()
  const coder =
    explicitCoder === undefined || explicitCoder.length === 0
      ? withModel(gemini, flashModel)
      : coderFromEnv(process.env)
  const reasoning =
    explicitCoder === undefined || explicitCoder.length === 0
      ? asReadOnly(withModel(gemini, proModel))
      : asReadOnly(coder)
  const reviewer =
    explicitCoder === undefined || explicitCoder.length === 0
      ? asReadOnly(withModel(gemini, flashModel))
      : asReadOnly(coder)
  const store = makePlanStore(nodePlainFileStore)
  const planPath = join(input.workDir, defaultPlanPath(input.prompt))

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning,
      reviewers: [reviewer],
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const plan = yield* stage(
          context.events,
          "specification and plan",
          store.recoverOrCreate(
            planPath,
            Effect.gen(function* () {
              const spec = yield* writeBrief(context.reasoning, input.prompt, specInstructions)
              const planned = yield* planFrom(context.reasoning, spec, planInstructions)
              return Plan.make({ ...planned, brief: spec })
            })
          )
        )
        const spec =
          plan.brief === undefined || plan.brief.length === 0
            ? yield* writeBrief(context.reasoning, input.prompt, specInstructions)
            : plan.brief
        const planWithSpec =
          plan.brief === undefined || plan.brief.length === 0
            ? Plan.make({ ...plan, brief: spec })
            : plan
        if (planWithSpec !== plan) {
          yield* store.save(planPath, planWithSpec)
        }

        yield* stage(context.events, "branch", context.git.checkoutOrCreate(planWithSpec.epicId))
        const specPath = join(input.workDir, `specs/${planWithSpec.epicId}.md`)
        yield* stage(
          context.events,
          "commit specification",
          nodePlainFileStore
            .read(specPath)
            .pipe(
              Effect.flatMap((existing) =>
                existing === undefined
                  ? nodePlainFileStore
                      .writeAtomic(specPath, `${spec}\n`)
                      .pipe(
                        Effect.andThen(
                          context.git.commitAll(`${planWithSpec.epicId}: specification`)
                        ),
                        Effect.asVoid
                      )
                  : Effect.void
              )
            )
        )

        const coderChat = yield* makeChat(context.coder, {
          system:
            "Implement one task at a time. The committed specification is the contract; do not weaken its tests."
        })
        const testGate = lintCommand(
          nodeProcessExecutor,
          context.events,
          ["mvn", "-q", "test"],
          input.workDir
        )
        const compileGate = lintCommand(
          nodeProcessExecutor,
          context.events,
          ["mvn", "-q", "test-compile"],
          input.workDir
        )
        const firstTitle = planWithSpec.tasks[0]?.title

        yield* implementTaskLoop(store, context.events, planPath, planWithSpec, (task) =>
          Effect.gen(function* () {
            const testsTask = task.title === firstTitle
            yield* coderChat.ask(planWithSpec.taskPrompt(task))
            yield* reviewAndFixLoop({
              reviewers: minimalReviewers,
              reviewerService: context.reviewers[0] ?? context.reasoning,
              coder: coderChat,
              taskTitle: task.title,
              currentDiff: context.git.diffAll,
              events: context.events,
              lint: testsTask ? compileGate : testGate,
              parallelism: 1
            })
            if (testsTask) {
              const red = yield* testGate
              if (red.isClean) {
                return yield* FlowAborted.make({
                  message:
                    "the new tests pass before implementation; the specification is not encoded by a red test"
                })
              }
            }
            yield* context.git.commitAll(`${planWithSpec.epicId}: ${task.title}`)
          })
        )
        yield* stage(
          context.events,
          "verify acceptance criteria",
          Effect.flatMap(testGate, (result) =>
            result.isClean ? Effect.void : Effect.fail(verificationFailure(result))
          )
        )
      })
  )
})

runExampleMain(program)
