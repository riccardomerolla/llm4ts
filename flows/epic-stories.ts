// Split an epic into stories with a declared dependency graph, approve the plan, then implement the stories with parallel coders in per-story worktrees merged into an epic branch.
//
//   llm4ts run epic-stories --repo ~/demo/portal "Add the current account and wire transfers"
//   llm4ts run epic-stories --repo ~/demo/portal -- --plan-only "…"   # write the plan and stop
//   llm4ts run epic-stories --repo ~/demo/portal -- --land            # land the finished epic on main
//   llm4ts run epic-stories --repo ~/demo/portal -- --list            # the repository's epics
//   llm4ts run epic-stories --repo ~/demo/portal -- --epic <id>       # resume one, no text needed
//
// The reasoning seat (LLM4TS_REASONER, default claude) splits the epic,
// reviews every task and judges every story; the coder seat (LLM4TS_CODER,
// default pi) implements; LLM4TS_CODER_MODEL / LLM4TS_REASONING_MODEL pick
// their models (pi: "provider/model"). The story plan is persisted under
// .llm4ts/epics/<epic-id>/plan.md BEFORE any coder runs, and an existing
// file wins over regeneration — editing it is the approval and the re-plan
// path. Stories run in worktrees BESIDE the repository (<repo>.worktrees/
// <epic-id>/<story-id>, LLM4TS_WORKTREE_ROOT to move them) under
// --concurrency (default 3); a failed story puts its dependents on hold
// (--fail-fast stops instead). The epic branch is left in place; the board
// and the report under .llm4ts/epics/<epic-id>/ carry ESTIMATED usage
// figures (ADR 0013).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
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
import { landEpic } from "@llm4ts/flow/Landing"
import { implementStoriesFlow, type StorySeats } from "@llm4ts/flow/Stories"
import { makeStoryPlanStore, validateStoryPlan } from "@llm4ts/flow/StoryPlan"
import * as Console from "effect/Console"
import {
  awaitServer,
  chooseEpic,
  epicsDir,
  listEpics,
  renderEpicList,
  combineTotals,
  epicIdFor,
  flagsFromEnvironment,
  gateCommands,
  gatesIn,
  generateStoryPlan,
  httpProbe,
  judgeStory,
  localCoderServer,
  parseEpicArgs,
  reasonerFromEnvironment,
  serverHealthUrl,
  setupIn,
  storyCoderFromEnvironment,
  verifyBlockedOn,
  worktreeRootFor,
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

/** Extra CLI flags on top of a preset's own (`LLM4TS_CODER_FLAGS`). */
const withExtraFlags = (
  config: CliConnectorConfig,
  flags: Readonly<Record<string, string>>
): CliConnectorConfig =>
  Object.keys(flags).length === 0
    ? config
    : CliConnectorConfig.make({ ...config, flags: { ...config.flags, ...flags } })

const defaultEpic =
  "Add the retail customer's current account (Conto) with balance and movements, and wire " +
  "transfers (Bonifico) with beneficiary, review, SCA confirmation, and history."

const program = Effect.gen(function* () {
  const flags = yield* parseEpicArgs(process.argv.slice(2))
  // The epic is chosen before any seat is resolved: the text given, `--epic`,
  // or the one epic not landed yet (`chooseEpic`); `--list` only lists.
  const given = yield* resolveFlowInput("", flags.rest)
  const files = nodePlainFileStore
  const epics = yield* listEpics(files, given.workDir)
  if (flags.list) {
    yield* Console.log(renderEpicList(epics))
    return
  }
  const choice = yield* chooseEpic({
    text: given.prompt,
    epic: flags.epic,
    epics,
    defaultEpic
  })
  const input = {
    ...given,
    prompt: choice._tag === "Existing" ? choice.epic.epic : choice.prompt
  }
  const coderFlags = flagsFromEnvironment(process.env.LLM4TS_CODER_FLAGS)
  const reasoning = withExtraFlags(
    withOptionalModel(
      yield* reasonerFromEnvironment(process.env),
      process.env.LLM4TS_REASONING_MODEL
    ),
    flagsFromEnvironment(process.env.LLM4TS_REASONING_FLAGS)
  )
  const coder = withExtraFlags(
    withOptionalModel(
      yield* storyCoderFromEnvironment(process.env),
      process.env.LLM4TS_CODER_MODEL
    ),
    coderFlags
  )
  const localServer = localCoderServer(process.env.LLM4TS_CODER_MODEL, coderFlags, process.env)
  // A new epic's id (and state folder) is derived from its text; an existing
  // one keeps its folder, whatever text is on the command line.
  const epicId = choice._tag === "Existing" ? choice.epic.dir : epicIdFor(input.prompt)
  const stateDir = join(epicsDir(input.workDir), epicId)
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
        if (flags.land !== undefined) {
          const landed = yield* landEpic(context, {
            plan,
            files,
            stateDir,
            target: flags.land,
            keepWorktrees: flags.keepWorktrees,
            gates: gatesIn(nodeProcessExecutor, events, gateCommands(process.env)),
            system: ["House rules of the target repository (CONTRIBUTING.md):", guidance].join("\n")
          })
          yield* events.publish(
            Info.make({
              message: `epic ${plan.epicId}: landed on ${landed.target}${landed.conflicts.length === 0 ? "" : ` (${landed.conflicts.length} conflicted file(s) resolved in ${landed.rounds} round(s))`}`
            })
          )
          return
        }
        // With a roster, the default is every coder slot it has; the flag caps it.
        const concurrency = flags.concurrency ?? context.roster?.slots("coder") ?? 3
        if (context.roster === undefined && localServer !== undefined && concurrency > 1) {
          yield* events.publish(
            Info.make({
              message:
                `⚠ the coder is served by a local single-model server (${localServer}): it generates one ` +
                `reply at a time, so ${concurrency} parallel coders queue behind each other and a queued ` +
                'request is cut off after a few minutes ("terminated"). Prefer --concurrency 1, or give ' +
                "the server parallel slots."
            })
          )
        }

        const contextFor = context.contextFor
        if (contextFor === undefined) {
          return yield* FlowAborted.make({
            message: "this runner cannot rebind seats to a worktree (no contextFor)"
          })
        }
        const gates = gatesIn(nodeProcessExecutor, events, gateCommands(process.env))
        const setupCommand = worktreeSetupCommand(process.env)
        const healthUrl = serverHealthUrl(localServer, process.env)
        const report = yield* implementStoriesFlow(
          { ...context, reasoning: reasoningMeter.service },
          {
            plan,
            files,
            stateDir,
            worktreeRoot: worktreeRootFor(input.workDir, plan.epicId, process.env),
            board: makeLocalBoardSync(files, stateDir, `Epic: ${plan.epicId}`),
            contextFor: (workDir, contextOptions) =>
              Effect.gen(function* () {
                const rebound = yield* contextFor(workDir, contextOptions)
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
            // With a roster, the judge and the verifier are leased per story,
            // away from the executor coding it (ADR 0019).
            judge: (story, diff, seats) =>
              judgeStory(
                seats.context.roster?.forRole("judge") ?? reasoningMeter.service,
                story,
                diff,
                contextBudget,
                plan
              ),
            verifyBlocked: (story, need, workDir, seats) =>
              verifyBlockedOn(
                seats.context.roster?.forRole("verifier") ?? reasoningMeter.service,
                events,
                files,
                plan
              )(story, need, workDir),
            // A roster waits for its own executors (the story's next lease
            // does); without one, poll the single coder's engine.
            awaitRecovery:
              context.roster === undefined
                ? awaitServer(healthUrl === undefined ? undefined : httpProbe(healthUrl), events)
                : () => Effect.void,
            system: (story) =>
              Effect.succeed(
                [
                  "House rules of the target repository (CONTRIBUTING.md):",
                  guidance,
                  "",
                  `Imitate the exemplar feature before inventing anything. Story id: ${story.id}.`
                ].join("\n")
              ),
            concurrency,
            failFast: flags.failFast
          }
        )
        yield* events.publish(
          Info.make({
            message: `epic ${report.epicId}: ${report.count("done")} done, ${report.count("failed")} failed, ${report.count("waiting")} waiting — report at ${join(stateDir, "report.md")} (usage figures estimated)`
          })
        )
      })
  )
})

runFlowMain(program)
