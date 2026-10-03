// Read what a failed epic-stories run left behind and propose the fixes the next run applies once approved.
//
//   llm4ts run epic-retro --repo ~/demo/portal                       # the one open epic, its latest run
//   llm4ts run epic-retro --repo ~/demo/portal -- --epic <id>        # one epic
//   llm4ts run epic-retro --repo ~/demo/portal -- --epic <id> --run run-1759…   # one run of it
//
// The evidence is the run's trace, its transcripts when it was started with
// --transcript, the board, the report, and each story's plan, findings and
// judge verdict under .llm4ts/epics/<epic-id>/. Code digests them (the digest
// is written first, at retro/<runId>.digest.md); one read-only seat
// (LLM4TS_REASONER, the judge seat) turns the digest into a proposal: per
// story a diagnosis and exactly one fix — tasks appended to its plan, an
// edit to its entry (which restarts it), a refine round, or nothing — plus
// run advice and, where the library misbehaved, advice for llm4ts
// (retro/<runId>-library.md). Code validates the proposal before writing
// retro/<runId>.md, which ends in `- [ ] Approved`. Tick it and rerun
// epic-stories: the approved fixes are applied before any story runs, and
// the report is marked Applied. Nothing is applied unapproved; nothing in
// the target's git is touched.
import { join } from "node:path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import {
  ScriptUsage,
  asReadOnly,
  nodePlainFileStore,
  resolveFlowInput,
  runFlowMain,
  runNode
} from "@llm4ts/runner"
import { loadTranscript, nodeTranscriptFiles } from "@llm4ts/runner/Transcripts"
import { parseEpicRetroArgs, resolveRetroTarget, runRetro } from "./lib/epic-retro.ts"
import {
  chooseEpic,
  defaultEpic,
  epicsDir,
  listEpics,
  reasonerFromEnvironment
} from "./lib/epic-stories.ts"

const program = Effect.gen(function* () {
  const flags = yield* parseEpicRetroArgs(process.argv.slice(2))
  const given = yield* resolveFlowInput("", flags.rest)
  const files = nodePlainFileStore
  const epics = yield* listEpics(files, given.workDir)
  const choice = yield* chooseEpic({ text: "", epic: flags.epic, epics, defaultEpic })
  if (choice._tag !== "Existing") {
    return yield* ScriptUsage.make({
      message: `no planned epic to look at in ${given.workDir}; run epic-stories first`
    })
  }
  const epicDir = choice.epic.dir
  const stateDir = join(epicsDir(given.workDir), epicDir)
  const target = yield* resolveRetroTarget(files, stateDir, flags.run)
  const transcriptDir = join(given.workDir, ".llm4ts", "transcripts", target.run.runId)
  const reasoning = asReadOnly(yield* reasonerFromEnvironment(process.env))
  const outcome = yield* runNode(
    {
      workDir: given.workDir,
      workspace: given.workspace,
      userPrompt: `retro of run ${target.run.runId} of epic ${target.plan.epicId}`,
      // No coder turn is ever taken: the read-only reasoning seat fills both.
      coder: reasoning,
      reasoning,
      environment: process.env
    },
    (context) =>
      runRetro({
        files,
        events: context.events,
        seat: context.judge ?? context.reasoning,
        workDir: given.workDir,
        epicDir,
        target,
        transcript: (lane) => loadTranscript(nodeTranscriptFiles, transcriptDir, { lane }),
        environment: process.env,
        now: Date.now()
      })
  )
  if (outcome._tag === "NothingToDo") {
    yield* Console.log(outcome.message)
  }
})

runFlowMain(program)
