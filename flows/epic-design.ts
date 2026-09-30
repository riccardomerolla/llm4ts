// Design an epic brief from a legacy extract pack and a target repository: propose what the epic carries over, drops, finds already provided or defers, settle open points with the user in the file, and hand the approved brief to epic-stories.
//
//   LLM4TS_LEGACY_REPO=~/legacy/ib-core \
//     llm4ts run epic-design --repo ~/work/portal "Current account: balance, movements, statements"
//   llm4ts run epic-design --repo ~/work/portal -- --epic <id>    # revise, or validate once approved
//   llm4ts run epic-design --repo ~/work/portal -- --list         # the repository's briefs
//
// Runs rooted at the TARGET repository. The legacy repository must hold
// modernize-extract's pack (docs/modernization/); modernize-refine's
// decisions.md is respected when present. The FILE is the state:
// <target>/.llm4ts/epics/<epic-id>/brief.md. One run does one thing, decided
// from the file: propose it, revise it from your answers and `## Feedback`,
// halt on unanswered open points, wait for `Status: approved`, or validate
// the approved brief. Every scenario of every program the brief considers
// gets a disposition (in scope, dropped, provided by the target, deferred),
// every citation and pointer is checked, and what a fix round cannot clear
// is raised as a `[check]` open point. epic-stories --epic <id> then plans
// from the approved brief. Seat: LLM4TS_REASONER (read-only, default
// claude). LLM4TS_PACK describes the target stack when the target is new.
// LLM4TS_CONTEXT_BUDGET bounds the legacy evidence in the prompt.
import { access, readdir } from "node:fs/promises"
import { join } from "node:path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { budget, cap } from "@llm4ts/flow/Context"
import {
  Info,
  ScriptUsage,
  asReadOnly,
  nodePlainFileStore,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import {
  designEpic,
  parseEpicDesignArgs,
  renderBriefList,
  renderOutcome,
  resolveDesignTarget
} from "./lib/epic-design.ts"
import { epicDirs, listBriefs, reasonerFromEnvironment } from "./lib/epic-stories.ts"
import { ModDir } from "./lib/modernize-extract.ts"

const program = Effect.gen(function* () {
  const flags = yield* parseEpicDesignArgs(process.argv.slice(2))
  const given = yield* resolveFlowInput("", flags.rest)
  const files = nodePlainFileStore
  const briefs = yield* listBriefs(files, given.workDir, yield* epicDirs(given.workDir))
  if (flags.list) {
    yield* Console.log(renderBriefList(briefs))
    return
  }
  const legacyRepo = process.env.LLM4TS_LEGACY_REPO?.trim()
  if (legacyRepo === undefined || legacyRepo.length === 0) {
    return yield* ScriptUsage.make({
      message:
        "LLM4TS_LEGACY_REPO is not set: point it at the legacy repository holding docs/modernization/"
    })
  }
  const target = yield* resolveDesignTarget({ text: given.prompt, epic: flags.epic, briefs })
  const specNames = yield* Effect.tryPromise(() => readdir(join(legacyRepo, ModDir, "specs"))).pipe(
    Effect.map((names) =>
      names
        .filter((name) => name.endsWith(".md") && name !== "README.md")
        .map((name) => name.slice(0, -".md".length))
    ),
    Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([]))
  )
  const reasoning = asReadOnly(yield* reasonerFromEnvironment(process.env))

  yield* runNode(
    {
      workDir: given.workDir,
      workspace: given.workspace,
      userPrompt: target.request,
      // No coder turn is ever taken: the read-only reasoning seat fills both.
      coder: reasoning,
      reasoning,
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const guidance = cap(
          (yield* files.read(join(given.workDir, "CONTRIBUTING.md"))) ??
            "(no CONTRIBUTING.md in the target repository)",
          24_000
        ).text
        const packNote =
          (process.env.LLM4TS_PACK ?? "").trim().length === 0
            ? undefined
            : yield* stage(
                context.events,
                "pack",
                Effect.map(
                  openPack({
                    environment: process.env,
                    launchDir: given.workspace,
                    flowDir: import.meta.dirname
                  }),
                  ({ pack }) =>
                    [
                      `pack ${pack.name}`,
                      ...(pack.scaffold === undefined ? [] : [`scaffold: ${pack.scaffold}`]),
                      ...(pack.prompt("epic-design") === undefined
                        ? []
                        : [pack.prompt("epic-design") ?? ""])
                    ].join("\n")
                )
              )
        const outcome = yield* stage(
          context.events,
          "epic brief",
          designEpic({
            files,
            reasoning: context.reasoning,
            events: context.events,
            targetDir: given.workDir,
            legacyRepo,
            specNames,
            epicId: target.epicId,
            request: target.request,
            budget: budget(process.env),
            guidance,
            packNote,
            pathExists: (absolute) =>
              Effect.tryPromise(() => access(absolute)).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false))
              )
          })
        )
        for (const line of renderOutcome(outcome, target.epicId)) {
          yield* context.events.publish(Info.make({ message: line }))
        }
      })
  )
})

runFlowMain(program)
