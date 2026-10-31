// Run a taskforce on a goal: a Chief of Staff plans the briefs, specialists work them in waves, a Reviewer interrogates, the Doc Writer delivers; you steer from the plan file.
//
//   llm4ts run taskforce --repo ~/work/portal "Can the auth module move behind the new gateway? Outline and plan." \
//     -- --context docs/standards
//   llm4ts run taskforce --repo ~/work/portal -- --run can-the-auth-module-move-behind-the-new-gateway   # continue
//   llm4ts run taskforce --repo ~/work/portal -- --eject-personas           # the bundled cards, to edit
//   llm4ts run taskforce --repo ~/work/portal -- --list                     # runs and specialists
//
// Code runs the loop (ADR 0047). The Chief of Staff proposes the plan: the
// deliverables and two to twelve briefs (GOAL, SCOPE, CONTEXT, ACCEPTANCE,
// VERIFY, TIMEBOX, FORBIDDEN, REPORT) with owners and dependencies; the run
// stops for you to edit it unless --no-pause. Independent briefs run
// together (--parallel). Each specialist has hands by card: the Researcher
// and the Reviewer read the repository, the Operator's commands are run by
// code, the Engineer gets a throwaway worktree, the rest are toolless. A
// brief reports PASS, ISSUES or BLOCKED with evidence; BLOCKED is retried
// once. After the wave the Chief of Staff checks the goal and may plan one
// more wave. The Doc Writer writes the deliverables (result.md always), the
// review lenses find what is wrong, the Judgment service says what blocks
// the goal, one fix wave runs, the Doc Writer redrafts, the Memory Manager
// writes the run note. Three waves (--waves), twelve briefs (--briefs).
//
// The FILE is the state: <repo>/.llm4ts/taskforce/<id>/plan.md. Answer a
// question under `## Answers`, or write under `## Feedback`, and rerun.
// decisions.tsv is the trail. Cards are bundled, replaced by
// .llm4ts/personas/<name>.md of the same name; lenses by
// .llm4ts/lenses/<name>.md. Seats: LLM4TS_REASONER (default claude) for
// every card, LLM4TS_CODER (default claude) for the Engineer, or the
// roster's seat per role. Nothing in the repository's git is touched;
// worktrees live beside it (LLM4TS_WORKTREE_ROOT).
import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { budget } from "@llm4ts/flow/Context"
import { judgmentOf } from "@llm4ts/flow/Judgment"
import { parseNote, type MemoryNote } from "@llm4ts/flow/Memory"
import { parseReviewer, Reviewer } from "@llm4ts/flow/Reviewer"
import { parsePlan } from "@llm4ts/flow/Taskforce"
import {
  ScriptUsage,
  asReadOnly,
  asToolless,
  nodePlainFileStore,
  nodeProcessExecutor,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage,
  withTurnLimit
} from "@llm4ts/runner"
import { coderFromEnvironment } from "@llm4ts/runner/Connectors"
import { reasonerFromEnvironment, worktreeRootFor } from "./lib/epic-stories.ts"
import {
  bundledLenses,
  commandsPath,
  declaredCommands,
  defaultAgents,
  describeCast,
  ejectPersonas,
  lensesDir,
  parseTaskforceArgs,
  personasDir,
  resolveCast,
  runDir,
  runSlug,
  runsDir,
  runTaskforce,
  type ContextDoc
} from "./lib/taskforce.ts"

const files = nodePlainFileStore

const namesIn = (dir: string, suffix: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map(
      (entries): ReadonlyArray<string> =>
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
          .map((entry) => entry.name.slice(0, -suffix.length))
          .sort()
    ),
    Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([]))
  )

const foldersIn = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map(
      (entries): ReadonlyArray<string> =>
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
    ),
    Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([]))
  )

/** `<dir>/<name>.md`, keyed by name. */
const cardsIn = Effect.fn("taskforce.cardsIn")(function* (dir: string) {
  const names = yield* namesIn(dir, ".md")
  const cards: Record<string, string> = {}
  for (const name of names) {
    const text = yield* files.read(join(dir, `${name}.md`))
    if (text !== undefined) cards[name] = text
  }
  return cards
})

const textLike = /\.(md|markdown|txt|adoc|rst)$/i

/** Every text document under `--context`, recursively, in path order. */
const contextDocs = Effect.fn("taskforce.contextDocs")(function* (dir: string | undefined) {
  if (dir === undefined) return []
  const entries = yield* Effect.tryPromise(() =>
    readdir(dir, { withFileTypes: true, recursive: true })
  ).pipe(
    Effect.catch(() =>
      ScriptUsage.make({ message: `--context ${dir} is not a readable directory` })
    )
  )
  const paths = entries
    .filter((entry) => entry.isFile() && textLike.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
  const docs: Array<ContextDoc> = []
  for (const path of paths) {
    const text = yield* files.read(path)
    if (text !== undefined) docs.push({ path: path.slice(dir.length + 1), text })
  }
  return docs
})

/** Every note under `.llm4ts/memory/`, recursively, named by its path without `.md`. */
const memoryNotes = Effect.fn("taskforce.memoryNotes")(function* (dir: string) {
  const entries = yield* Effect.tryPromise(() =>
    readdir(dir, { withFileTypes: true, recursive: true })
  ).pipe(Effect.catch(() => Effect.succeed([])))
  const notes: Array<MemoryNote> = []
  for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))) {
    const path = join(entry.parentPath, entry.name)
    const text = yield* files.read(path)
    if (text !== undefined) notes.push(parseNote(path.slice(dir.length + 1, -3), text))
  }
  return notes.sort((left, right) => left.name.localeCompare(right.name))
})

const program = Effect.gen(function* () {
  const flags = yield* parseTaskforceArgs(process.argv.slice(2))
  const given = yield* resolveFlowInput("", flags.rest)
  const workDir = given.workDir

  if (flags.ejectPersonas) {
    const written = yield* ejectPersonas(files, workDir)
    yield* Console.log(
      written.length === 0
        ? `every bundled card is already under ${personasDir(workDir)}`
        : `wrote ${written.length} card(s):\n${written.map((path) => `  ${path}`).join("\n")}`
    )
    return
  }

  const custom = yield* cardsIn(personasDir(workDir))
  const memory = !flags.noMemory
  if (flags.list) {
    const ids = yield* foldersIn(runsDir(workDir))
    const lines: Array<string> = []
    for (const id of ids) {
      const text = yield* files.read(join(runDir(workDir, id), "plan.md"))
      const plan = text === undefined ? undefined : yield* parsePlan(text).pipe(Effect.option)
      lines.push(
        plan === undefined || plan._tag === "None"
          ? `  ${id}  (no readable plan.md)`
          : `  ${id}  ${plan.value.status}  ${plan.value.goal}`
      )
    }
    const cast = yield* resolveCast(custom, defaultAgents, memory)
    yield* Console.log(
      [
        lines.length === 0 ? `no runs under ${runsDir(workDir)}` : "runs:",
        ...lines,
        "",
        `specialists (bundled${Object.keys(custom).length === 0 ? "" : `, ${Object.keys(custom).length} custom`}):`,
        describeCast(cast.all)
      ].join("\n")
    )
    return
  }

  const goal = given.prompt.trim()
  const runId = flags.run ?? (goal.length === 0 ? undefined : runSlug(goal))
  if (runId === undefined) {
    return yield* ScriptUsage.make({
      message: `give the goal to start a run, or --run <id> to continue one`
    })
  }
  // An existing run's cast is the file's; --agents only seats a new one.
  const existing = yield* files.read(join(runDir(workDir, runId), "plan.md"))
  const agents =
    existing === undefined
      ? (flags.agents ?? defaultAgents)
      : (yield* parsePlan(existing, join(runDir(workDir, runId), "plan.md"))).cast.filter(
          (name) => name !== "Chief of Staff" && name !== "Doc Writer"
        )
  const cast = yield* resolveCast(custom, agents, memory)
  const docs = yield* contextDocs(
    flags.context === undefined ? undefined : resolve(workDir, flags.context)
  )
  const notes = memory ? yield* memoryNotes(join(workDir, ".llm4ts", "memory")) : []
  const lensCards = yield* cardsIn(lensesDir(workDir))
  const lenses =
    Object.keys(lensCards).length === 0
      ? bundledLenses.map((lens) => Reviewer.make(lens))
      : Object.entries(lensCards).map(([name, text]) => parseReviewer(name, text))
  const allowedCommand = declaredCommands(
    yield* files.read(join(workDir, "package.json")),
    yield* files.read(commandsPath(workDir))
  )
  const reasoner = yield* reasonerFromEnvironment(process.env)
  const coder = withTurnLimit(yield* coderFromEnvironment(process.env), flags.turns ?? 30)
  const worktreeRoot = worktreeRootFor(workDir, `taskforce-${runId}`, process.env)

  const outcome = yield* runNode(
    {
      workDir,
      workspace: given.workspace,
      userPrompt: goal.length === 0 ? `taskforce ${runId}` : goal,
      coder,
      reasoning: asToolless(reasoner),
      reviewers: [asReadOnly(reasoner)],
      environment: process.env
    },
    (context) =>
      stage(
        context.events,
        "taskforce",
        runTaskforce({
          files,
          events: context.events,
          workDir,
          runId,
          goal,
          cast,
          context: docs,
          notes,
          caps: { waves: flags.waves ?? 3, briefs: flags.briefs ?? 12 },
          parallel: flags.parallel ?? context.roster?.slots("planner") ?? 1,
          noPause: flags.noPause,
          keepWork: flags.keepWork,
          memory,
          budget: budget(process.env),
          seats: {
            toolless: context.reasoning,
            readOnly: context.reviewers[0] ?? context.reasoning,
            ...(context.roster === undefined
              ? {}
              : { forSeat: (role) => context.roster?.forRole(role) ?? context.reasoning })
          },
          judgment: judgmentOf(context),
          lenses,
          processes: nodeProcessExecutor,
          allowedCommand,
          workspaceFor: (brief) =>
            Effect.gen(function* () {
              const dir = join(worktreeRoot, brief.id)
              yield* context.git.addWorktreeNewBranch(dir, `taskforce/${runId}/${brief.id}`, "HEAD")
              const rebound =
                context.contextFor === undefined
                  ? context
                  : yield* context.contextFor(dir, { label: brief.id })
              return { dir, coder: rebound.coder, diff: rebound.git.diffAll }
            }),
          removeWorkspace: (dir) => context.git.removeWorktree(dir, true),
          now: () => new Date().toISOString()
        })
      )
  )
  if (outcome._tag === "NothingToDo") {
    yield* Console.log(outcome.message)
  } else {
    yield* Console.log(outcome.summary.join("\n"))
  }
})

runFlowMain(program)
