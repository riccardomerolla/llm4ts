// Run a meeting of personas on a topic toward a goal: they discuss item by item, a Scribe writes the solution outline and the plan, you steer from the meeting file.
//
//   llm4ts run roundtable --repo ~/work/portal "Architecture outline for the payments hub" \
//     -- --goal "An outline and a plan the committee can approve, within our standards" \
//        --agents "PO,PM,Sr SW Eng,Cloud Architect,DevOps,SRE" --context docs/standards
//   llm4ts run roundtable --repo ~/work/portal -- --meeting payments-hub     # continue, or fold in your answers
//   llm4ts run roundtable --repo ~/work/portal -- --eject-personas           # the bundled cards, to edit
//   llm4ts run roundtable --repo ~/work/portal -- --list                     # meetings and personas
//
// Code chairs the meeting (ADR 0046). The first attendee proposes the agenda;
// the run stops for you to edit it unless --no-pause. Then every attendee is
// asked once per round, in persona order, on each item: a position, a
// proposal, an objection (blocking or not), a question (for the room, or
// parked for you), an agreement, or a pass. An item settles after a complete
// round with no open blocking objection and no open question; silence is
// consent. Three rounds per item (--rounds), forty turns in all (--max-turns);
// what is still open is written down, never forced. Then the Scribe writes
// outline.md and plan.md, code renders decisions.md (with the dissent) and
// open-questions.md, every attendee reviews once, the Scribe fixes what
// blocks, and the meeting is done.
//
// The FILE is the state: <repo>/.llm4ts/meetings/<id>/meeting.md. Answer a
// parked question under `## Answers`, or write under `## Feedback`, and
// rerun: your words become turns, the item reopens for one more round and the
// drafts are rewritten. Personas are cards: bundled ones, replaced by
// .llm4ts/personas/<name>.md of the same name. Every persona borrows one
// read-only, toolless seat: LLM4TS_REASONER (default claude). --context
// gives every attendee the same documents, under LLM4TS_CONTEXT_BUDGET.
// Nothing in the repository's git is touched.
import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { budget } from "@llm4ts/flow/Context"
import { judgmentOf } from "@llm4ts/flow/Judgment"
import { parseMeeting } from "@llm4ts/flow/Roundtable"
import {
  ScriptUsage,
  asToolless,
  nodePlainFileStore,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { reasonerFromEnvironment } from "./lib/epic-stories.ts"
import {
  describePersonas,
  ejectPersonas,
  meetingDir,
  meetingSlug,
  meetingsDir,
  parseRoundtableArgs,
  personasDir,
  resolvePersonas,
  runRoundtable,
  type ContextDoc
} from "./lib/roundtable.ts"
import { defaultAttendees } from "./lib/roundtable-personas.ts"

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

/** `.llm4ts/personas/<name>.md`, keyed by name. */
const customCards = Effect.fn("roundtable.customCards")(function* (workDir: string) {
  const dir = personasDir(workDir)
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
const contextDocs = Effect.fn("roundtable.contextDocs")(function* (dir: string | undefined) {
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

const program = Effect.gen(function* () {
  const flags = yield* parseRoundtableArgs(process.argv.slice(2))
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

  const custom = yield* customCards(workDir)
  if (flags.list) {
    const ids = yield* foldersIn(meetingsDir(workDir))
    const lines: Array<string> = []
    for (const id of ids) {
      const text = yield* files.read(join(meetingDir(workDir, id), "meeting.md"))
      const meeting = text === undefined ? undefined : yield* parseMeeting(text).pipe(Effect.option)
      lines.push(
        meeting === undefined || meeting._tag === "None"
          ? `  ${id}  (no readable meeting.md)`
          : `  ${id}  ${meeting.value.status}  ${meeting.value.topic}`
      )
    }
    const personas = yield* resolvePersonas(custom, defaultAttendees)
    yield* Console.log(
      [
        lines.length === 0 ? `no meetings under ${meetingsDir(workDir)}` : "meetings:",
        ...lines,
        "",
        `personas (bundled${Object.keys(custom).length === 0 ? "" : `, ${Object.keys(custom).length} custom`}):`,
        describePersonas([...personas.attendees, personas.scribe])
      ].join("\n")
    )
    return
  }

  const topic = given.prompt.trim()
  const meetingId = flags.meeting ?? (topic.length === 0 ? undefined : meetingSlug(topic))
  if (meetingId === undefined) {
    return yield* ScriptUsage.make({
      message: `give the topic to start a meeting, or --meeting <id> to continue one`
    })
  }
  // An existing meeting's attendees are the file's; --agents only seats a new one.
  const existing = yield* files.read(join(meetingDir(workDir, meetingId), "meeting.md"))
  const attendeeNames =
    existing === undefined
      ? (flags.agents ?? defaultAttendees)
      : (yield* parseMeeting(existing, join(meetingDir(workDir, meetingId), "meeting.md")))
          .attendees
  const personas = yield* resolvePersonas(custom, attendeeNames)
  // Relative to the repository: the standards usually live beside the code.
  const docs = yield* contextDocs(
    flags.context === undefined ? undefined : resolve(workDir, flags.context)
  )
  const reasoning = asToolless(yield* reasonerFromEnvironment(process.env))

  const outcome = yield* runNode(
    {
      workDir,
      workspace: given.workspace,
      userPrompt: topic.length === 0 ? `roundtable ${meetingId}` : topic,
      // No coder turn is ever taken: the toolless reasoning seat fills both.
      coder: reasoning,
      reasoning,
      environment: process.env
    },
    (context) =>
      stage(
        context.events,
        "roundtable",
        runRoundtable({
          files,
          events: context.events,
          seat: context.reasoning,
          judgment: judgmentOf(context),
          workDir,
          meetingId,
          topic,
          goal: flags.goal,
          attendees: personas.attendees,
          scribe: personas.scribe,
          context: docs,
          caps: {
            roundsPerItem: flags.rounds ?? 3,
            maxTurns: flags.maxTurns ?? 40
          },
          noPause: flags.noPause,
          budget: budget(process.env)
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
