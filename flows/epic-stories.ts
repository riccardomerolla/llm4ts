// Split an epic into stories with a declared dependency graph, approve the plan, then implement the stories with parallel coders in per-story worktrees merged into an epic branch.
//
//   llm4ts run epic-stories --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-stories --repo ~/demo/portal -- --plan-only "…"   # write the plan and stop
//
// The reasoning seat (LLM4TS_REASONER, default claude) splits the epic,
// reviews every task and judges every story; the coder seat (LLM4TS_CODER,
// default pi) implements; LLM4TS_CODER_MODEL / LLM4TS_REASONING_MODEL pick
// their models (pi: "provider/model"). The story plan is persisted under
// .llm4ts/epics/<epic-id>/plan.md BEFORE any coder runs, and an existing
// file wins over regeneration — editing it is the approval and the re-plan
// path. Stories run in .llm4ts/worktrees/<story-id> under --concurrency
// (default 3); a failed story skips its dependents (--fail-fast stops
// instead). The epic branch is left in place; the board and the report
// under .llm4ts/epics/<epic-id>/ carry ESTIMATED usage figures (ADR 0013).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { budget, cap } from "@llm4ts/flow/Context"
import { makeLocalBoardSync } from "@llm4ts/flow/BoardSync"
import { estimatedUsageOptionsFromEnv, makeEstimatedUsageMeter } from "@llm4ts/flow/EstimatedUsage"
import {
  FlowAborted,
  Info,
  asReadOnly,
  nodePlainFileStore,
  nodeProcessExecutor,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage,
  withModel
} from "@llm4ts/runner"
import { implementStoriesFlow, type StorySeats } from "@llm4ts/flow/Stories"
import { makeStoryPlanStore, validateStoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  combineTotals,
  epicIdFor,
  gateCommands,
  gatesIn,
  generateStoryPlan,
  judgeStory,
  parseEpicArgs,
  reasonerFromEnvironment,
  setupIn,
  storyCoderFromEnvironment,
  worktreeSetupCommand
} from "./lib/epic-stories.ts"

/** `LLM4TS_CODER_MODEL` / `LLM4TS_REASONING_MODEL`: pi takes `provider/model` (e.g. `openai-codex/gpt-5.5`). */
const withOptionalModel = (
  config: CliConnectorConfig,
  model: string | undefined
): CliConnectorConfig => {
  const trimmed = model?.trim()
  return trimmed === undefined || trimmed.length === 0 ? config : withModel(config, trimmed)
}

const defaultEpic =
  "Add the retail customer's current account (Conto) with balance and movements, and wire " +
  "transfers (Bonifico) with beneficiary, review, SCA confirmation, and history."

const program = Effect.gen(function* () {
  const flags = yield* parseEpicArgs(process.argv.slice(2))
  const input = yield* resolveFlowInput(defaultEpic, flags.rest)
  const reasoning = withOptionalModel(
    yield* reasonerFromEnvironment(process.env),
    process.env.LLM4TS_REASONING_MODEL
  )
  const coder = withOptionalModel(
    yield* storyCoderFromEnvironment(process.env),
    process.env.LLM4TS_CODER_MODEL
  )
  const files = nodePlainFileStore
  const epicId = epicIdFor(input.prompt)
  const stateDir = join(input.workDir, ".llm4ts", "epics", epicId)
  const planPath = join(stateDir, "plan.md")
  const estimateOptions = estimatedUsageOptionsFromEnv(process.env)
  const contextBudget = budget(process.env)

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning,
      reviewers: [asReadOnly(reasoning)],
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const events = context.events
        const reasoningMeter = yield* makeEstimatedUsageMeter(context.reasoning, estimateOptions)
        const guidance = yield* Effect.map(
          files.read(join(input.workDir, "CONTRIBUTING.md")),
          (text) => cap(text ?? "(no CONTRIBUTING.md in the target repository)", 24_000).text
        )

        const store = makeStoryPlanStore(files)
        const plan = yield* stage(
          events,
          "story plan",
          store
            .recoverOrCreate(
              planPath,
              generateStoryPlan(reasoningMeter.service, events, input.prompt, epicId, guidance)
            )
            .pipe(Effect.flatMap(validateStoryPlan))
        )
        yield* events.publish(
          Info.make({
            message: `story plan: ${plan.stories.length} stories at ${planPath} (edit and rerun to re-plan)`
          })
        )
        if (flags.planOnly) {
          return
        }

        const contextFor = context.contextFor
        if (contextFor === undefined) {
          return yield* FlowAborted.make({
            message: "this runner cannot rebind seats to a worktree (no contextFor)"
          })
        }
        const gates = gatesIn(nodeProcessExecutor, events, gateCommands(process.env))
        const setupCommand = worktreeSetupCommand(process.env)
        const report = yield* implementStoriesFlow(
          { ...context, reasoning: reasoningMeter.service },
          {
            plan,
            files,
            stateDir,
            worktreeRoot: join(input.workDir, ".llm4ts", "worktrees"),
            board: makeLocalBoardSync(files, stateDir, `Epic: ${plan.epicId}`),
            contextFor: (workDir) =>
              Effect.gen(function* () {
                const rebound = yield* contextFor(workDir)
                const coderMeter = yield* makeEstimatedUsageMeter(rebound.coder, estimateOptions)
                const reviewMeter = yield* makeEstimatedUsageMeter(
                  rebound.reasoning,
                  estimateOptions
                )
                const seats: StorySeats = {
                  context: {
                    ...rebound,
                    coder: coderMeter.service,
                    reasoning: reviewMeter.service
                  },
                  totals: combineTotals(coderMeter.totals, reviewMeter.totals)
                }
                return seats
              }),
            ...(setupCommand === undefined
              ? {}
              : { setup: setupIn(nodeProcessExecutor, events, setupCommand) }),
            gates,
            judge: (story, diff) => judgeStory(reasoningMeter.service, story, diff, contextBudget),
            system: (story) =>
              Effect.succeed(
                [
                  "House rules of the target repository (CONTRIBUTING.md):",
                  guidance,
                  "",
                  `Imitate the exemplar feature before inventing anything. Story id: ${story.id}.`
                ].join("\n")
              ),
            ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
            failFast: flags.failFast
          }
        )
        yield* events.publish(
          Info.make({
            message: `epic ${report.epicId}: ${report.count("done")} done, ${report.count("failed")} failed, ${report.count("skipped")} skipped — report at ${join(stateDir, "report.md")} (usage figures estimated)`
          })
        )
      })
  )
})

runFlowMain(program)
