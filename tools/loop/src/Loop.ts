import { readFile, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeChat } from "@llm4ts/flow/Chat"
import { checkCostBudget, CostBudget, makeCostRecord } from "@llm4ts/flow/CostLedger"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { flowReviewer } from "@llm4ts/flow/Flow"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { implementTaskLoop } from "@llm4ts/flow/PlanExecution"
import type { Plan } from "@llm4ts/flow/Plan"
import { stableHash } from "@llm4ts/flow/Plan"
import { planFrom } from "@llm4ts/flow/Planner"
import { lintCommand, minimalReviewers, reviewAndFixLoop } from "@llm4ts/flow/Review"
import { coderFromEnv, withTurnLimit } from "@llm4ts/runner/Connectors"
import {
  makeFlowRunnerContext,
  nodeFlowRunnerDependencies,
  runWithBundle
} from "@llm4ts/runner/FlowRunner"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { parseVerbosity } from "@llm4ts/runner/Terminal"
import { syncCheckboxes } from "./CheckboxSync.ts"

export const LoopUsage =
  "usage: loop <spec-path> [--repo <path>] [--dry-run]\n" +
  "  spec-path        the specs/pending/*.md file to implement (one spec per run)\n" +
  "  --repo, -C       repository the loop develops (default: current directory)\n" +
  "  --dry-run        plan and print the tasks, then stop without touching the repo\n" +
  "  -h, --help       show this help\n" +
  "\n" +
  "environment:\n" +
  "  LLM4TS_CODER              coding agent: claude|codex|gemini|pi|agy|grok|cursor|opencode\n" +
  "  LLM4TS_LOOP_BUDGET_USD    per-run cost ceiling (default: 5)\n" +
  "  LLM4TS_LOOP_TURN_LIMIT    per-task turn limit for the coder\n" +
  "  LLM4TS_LOOP_GATE          CI gate command (default: the four-command chain)\n" +
  "  LLM4TS_LOOP_FORMAT        best-effort formatter before review rounds (default: pnpm format)\n" +
  "  LLM4TS_LOOP_MAX_ROUNDS    review-and-fix rounds before giving up (default: 3)\n" +
  "  LLM4TS_VERBOSITY          terminal verbosity: quiet|normal|verbose"

export const defaultGateCommand = "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test"
export const defaultBudgetUsd = 5

export interface LoopArgs {
  readonly specPath: string
  readonly repo: string
  readonly dryRun: boolean
}

export type LoopArgsParseResult =
  | { readonly ok: true; readonly value: LoopArgs }
  | { readonly ok: false; readonly help: boolean; readonly error: ScriptUsage }

export const parseLoopArgs = (argv: ReadonlyArray<string>): LoopArgsParseResult => {
  let specPath: string | undefined
  let repo = "."
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if (argument === "-h" || argument === "--help") {
      return { ok: false, help: true, error: ScriptUsage.make({ message: LoopUsage }) }
    } else if (argument === "--dry-run") {
      dryRun = true
    } else if (argument === "--repo" || argument === "-C") {
      const value = argv[index + 1]
      if (value === undefined) {
        return {
          ok: false,
          help: false,
          error: ScriptUsage.make({ message: `${argument} requires a path\n${LoopUsage}` })
        }
      }
      repo = value
      index += 1
    } else if (argument.startsWith("--repo=")) {
      repo = argument.slice("--repo=".length)
    } else if (argument.startsWith("--")) {
      return {
        ok: false,
        help: false,
        error: ScriptUsage.make({ message: `unknown flag: ${argument}\n${LoopUsage}` })
      }
    } else if (specPath === undefined && argument.trim().length > 0) {
      specPath = argument.trim()
    }
  }
  if (specPath === undefined) {
    return { ok: false, help: false, error: ScriptUsage.make({ message: LoopUsage }) }
  }
  return { ok: true, value: { specPath, repo, dryRun } }
}

const readNumberEnv = (
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number
): number => {
  const raw = environment[key]?.trim()
  if (raw === undefined || raw.length === 0) {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const readSpec = (specPath: string): Effect.Effect<string, ScriptUsage> =>
  Effect.tryPromise({
    try: () => readFile(specPath, "utf8"),
    catch: (error) =>
      ScriptUsage.make({
        message: `could not read spec ${specPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
  })

const resolveRepo = (repo: string, workspace: string): Effect.Effect<string, ScriptUsage> => {
  const path = resolve(workspace, repo)
  return Effect.tryPromise({
    try: async () => {
      const information = await stat(path)
      if (!information.isDirectory()) {
        throw new Error("not a directory")
      }
      return path
    },
    catch: (error) =>
      ScriptUsage.make({
        message: `--repo is not a directory: ${path}${
          error instanceof Error ? ` (${error.message})` : ""
        }`
      })
  })
}

export interface LoopConfig {
  readonly args: LoopArgs
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly workspace: string
}

/**
 * Run the dogfood loop for a single spec: plan the spec into tasks, then work
 * each task under runtime-owned git — checkpoint, a fresh chat, review-and-fix
 * against the CI gate, commit on green, roll back on failure. Checkbox state in
 * the spec is synchronised from the persisted plan on the way out.
 */
export const runLoop = (config: LoopConfig): Effect.Effect<void, FlowError | ScriptUsage> =>
  Effect.gen(function* () {
    const { args, environment, workspace } = config
    const specPath = resolve(workspace, args.specPath)
    const prompt = yield* readSpec(specPath)
    const workDir = yield* resolveRepo(args.repo, workspace)

    const turnLimit = environment.LLM4TS_LOOP_TURN_LIMIT?.trim()
    const baseCoder = coderFromEnv(environment)
    const coder =
      turnLimit === undefined || turnLimit.length === 0 || !Number.isInteger(Number(turnLimit))
        ? baseCoder
        : withTurnLimit(baseCoder, Number(turnLimit))

    const budget = CostBudget.make({
      maximumCostUsd: readNumberEnv(environment, "LLM4TS_LOOP_BUDGET_USD", defaultBudgetUsd)
    })
    const gateCommand = environment.LLM4TS_LOOP_GATE?.trim() ?? defaultGateCommand
    const formatCommand = environment.LLM4TS_LOOP_FORMAT?.trim() ?? "pnpm format"
    const maxRounds = readNumberEnv(environment, "LLM4TS_LOOP_MAX_ROUNDS", 3)

    const startedAtMs = yield* Clock.currentTimeMillis
    const runId = startedAtMs.toString()
    const at = new Date(startedAtMs).toISOString()
    const planPath = join(
      workDir,
      ".llm4ts",
      `loop-${basename(specPath)}-${stableHash(specPath)}.md`
    )
    const tracePath = join(workDir, ".llm4ts", `loop-trace-${runId}.jsonl`)

    const store = makePlanStore(nodePlainFileStore)
    const dependencies = nodeFlowRunnerDependencies()

    const options = {
      workDir,
      workspace,
      userPrompt: prompt,
      coder: CliConnectorConfig.make({ ...coder, workingDir: workDir }),
      tracePath,
      runId,
      verbosity: parseVerbosity(environment.LLM4TS_VERBOSITY)
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(bundle.events)

        const body = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
          Effect.gen(function* () {
            const plan = yield* store.recoverOrCreate(planPath, planFrom(context.reasoning, prompt))

            if (args.dryRun) {
              yield* context.events.publish(
                Info.make({ message: `dry run — ${plan.tasks.length} task(s) planned` })
              )
              yield* context.events.publish(Info.make({ message: `\n${plan.render}` }))
              return
            }

            const ciGate = lintCommand(
              nodeProcessExecutor,
              context.events,
              ["sh", "-lc", gateCommand],
              workDir
            )
            // The CSP "formatter step": best-effort, never fails the flow. The
            // headless coder cannot run commands itself, so deterministic
            // formatting must happen here, not by asking the model to imitate
            // prettier (dogfood run 3 died exactly that way).
            const formatStep: Effect.Effect<void, FlowError> =
              formatCommand.length === 0
                ? Effect.void
                : Effect.ignore(nodeProcessExecutor.run(["sh", "-lc", formatCommand], workDir, {}))

            const perTask = (task: Plan["tasks"][number]): Effect.Effect<void, FlowError> =>
              Effect.gen(function* () {
                const checkpoint = yield* context.git.checkpoint
                const attempt = Effect.gen(function* () {
                  const chat = yield* makeChat(context.coder)
                  yield* chat.ask(plan.taskPrompt(task))
                  const produced = yield* context.git.diffAll
                  if (produced.trim().length === 0) {
                    yield* context.events.publish(
                      Info.make({
                        message: `task "${task.title}" produced no changes (already satisfied); skipping review and commit`
                      })
                    )
                    return
                  }
                  yield* reviewAndFixLoop({
                    reviewers: minimalReviewers,
                    reviewerService: flowReviewer(context),
                    coder: chat,
                    taskTitle: task.title,
                    currentDiff: context.git.diffAll,
                    events: context.events,
                    maxRounds,
                    lint: ciGate,
                    format: formatStep
                  })
                  const gate = yield* ciGate
                  if (!gate.isClean) {
                    return yield* FlowAborted.make({
                      message: [
                        `task "${task.title}": the CI gate is still failing after review settled; refusing to commit`,
                        ...gate.issues.map((issue) => {
                          const detail =
                            issue.description.length === 0
                              ? ""
                              : `\n${issue.description.slice(-2000)}`
                          return `- [${issue.severity}] ${issue.title}${detail}`
                        })
                      ].join("\n")
                    })
                  }
                  yield* context.git.commitAll(`${plan.epicId}: ${task.title}`)
                  yield* tracker.awaitDrained(bundle.events)
                  const cells = yield* tracker.cells
                  yield* checkCostBudget(
                    makeCostRecord({ runId, at, repo: workDir, prompt, cells }),
                    budget
                  )
                })
                yield* attempt.pipe(
                  Effect.onError(() => Effect.ignore(context.git.rollback(checkpoint)))
                )
              })

            yield* implementTaskLoop(store, context.events, planPath, plan, perTask)
          })

        const syncSpec = Effect.gen(function* () {
          const persisted = yield* store.load(planPath)
          if (persisted === undefined) {
            return
          }
          const content = yield* nodePlainFileStore.read(specPath)
          if (content === undefined) {
            return
          }
          const completed = persisted.tasks.filter((task) => task.completed).length
          const allComplete = persisted.tasks.length > 0 && persisted.nextIncomplete === undefined
          const result = syncCheckboxes(content, completed, allComplete, persisted.tasks.length)
          if (result.markdown !== content) {
            yield* nodePlainFileStore.writeAtomic(specPath, result.markdown)
          }
        }).pipe(Effect.ignore)

        const flow = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
          args.dryRun ? body(context) : Effect.ensuring(body(context), syncSpec)

        yield* runWithBundle(bundle, options, flow, dependencies)
      })
    )
  })
