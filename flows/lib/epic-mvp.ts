// epic-mvp (ADR 0042): epic-stories' spine with a test-first policy that
// reaches an MVP sooner. The planner cuts every story to its MVP outcomes
// and parks the rest; each story writes its red tests first (one short
// review of the tests, then frozen), and green tests replace the review
// lenses and the story judge. The run ends MVP reached — every MVP outcome's
// tests pass on the epic branch — or MVP not reached, with parked.md saying
// what is left. `--iterate` plans the parked items as the next round.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import { makeChat } from "@llm4ts/flow/Chat"
import type { FlowLlmError } from "@llm4ts/flow/FlowError"
import {
  FlowAborted,
  StoryFailed,
  StoryPlanInvalid,
  type FlowError,
  type PersistenceError
} from "@llm4ts/flow/FlowError"
import { CriterionChecked, Info, Parked, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { correctnessReviewer, lintCommand, reviewWith } from "@llm4ts/flow/Review"
import { Reviewer } from "@llm4ts/flow/Reviewer"
import {
  RedTests,
  RedTestsVersion,
  redTestsPath,
  type EpicReport,
  type RedPhase,
  type StorySeats
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  commandFor,
  criterionTags,
  evidenceSourceFromEnvironment,
  parseJUnit,
  statusFromReport,
  testPaths,
  type CriterionStatus,
  type EvidenceSource
} from "@llm4ts/flow/TestEvidence"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { nodeProcessExecutor, ScriptUsage } from "@llm4ts/runner"
import {
  storyJsonSchema,
  storyPlanInstructions,
  type EpicStoriesOptions,
  type EpicUnitContext,
  type PlanInputs
} from "./epic-stories.ts"

// ---- Flags ------------------------------------------------------------------

export interface MvpFlags {
  /** `--iterate`: plan the parked items (and the text given) as the next round. */
  readonly iterate: boolean
  /** `--review`: one correctness lens per task, on top of the tests. */
  readonly review: boolean
  /** Everything else, for epic-stories' own flags (`--iterate` becomes `--refine`). */
  readonly argv: ReadonlyArray<string>
}

export const parseMvpFlags = (argv: ReadonlyArray<string>): MvpFlags => {
  const iterate = argv.includes("--iterate")
  const review = argv.includes("--review")
  const rest = argv.filter((arg) => arg !== "--iterate" && arg !== "--review")
  return { iterate, review, argv: iterate ? ["--refine", ...rest] : rest }
}

// ---- The MVP cut ------------------------------------------------------------

/** A whole story the planner cut from this iteration. */
export class ParkedStory extends Schema.Class<ParkedStory>("ParkedStory")({
  title: Schema.String,
  why: Schema.String
}) {}

/** What the MVP planner answers: the stories to build now and the ones parked whole. */
export class MvpPlan extends Schema.Class<MvpPlan>("MvpPlan")({
  epicId: Schema.String,
  epic: Schema.String,
  stories: Schema.Array(Story),
  parked: Schema.Array(ParkedStory).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
}) {}

export const mvpPlanJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    epicId: { type: "string" },
    epic: { type: "string" },
    stories: {
      type: "array",
      items: {
        ...storyJsonSchema,
        properties: {
          ...storyJsonSchema.properties,
          later: { type: "array", items: { type: "string" } }
        }
      }
    },
    parked: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, why: { type: "string" } },
        required: ["title", "why"]
      }
    }
  },
  required: ["epicId", "epic", "stories", "parked"]
}

/** The epic-stories planner's rules, then the MVP cut on top. */
export const mvpPlanInstructions = (
  epicId: string,
  guidance: string,
  orientation?: string
): string =>
  [
    storyPlanInstructions(epicId, guidance, orientation),
    "",
    "MVP cut (this run is epic-mvp: reach a working MVP first, park the rest for a later iteration):",
    "- `acceptance` holds ONLY the outcomes the MVP cannot ship without, one to four per story, each",
    "  checkable by an automated test (a test will be written for it before any code).",
    "- `later` holds the story's other outcomes: polish, edge cases beyond the main path, extra",
    "  options. They are shown to the operator and not built now.",
    "- A whole story the MVP does not need goes to the top-level `parked` list as",
    '  {"title":"…","why":"…"} instead of `stories`. Every story in `stories` has at least one',
    "  `acceptance` outcome, and none depends on a parked one.",
    "- Prefer fewer, thinner stories: the thinnest end-to-end path that works.",
    "- Items an approved brief marks deferred or dropped are parked, never planned.",
    'Add `"later":[…]` to each story and `"parked":[…]` beside `"stories"` in the JSON.'
  ].join("\n")

/** The MVP planner: writes `mvp-cut.json` beside the plan with the stories parked whole. */
export const generateMvpPlan = (
  inputs: PlanInputs
): Effect.Effect<StoryPlan, FlowLlmError | PersistenceError> =>
  Effect.gen(function* () {
    const answer = yield* structuredAndPublish(
      inputs.reasoning,
      inputs.events,
      `${mvpPlanInstructions(inputs.epicId, inputs.guidance, inputs.orientation)}\n\nEpic:\n${inputs.brief ?? inputs.epic}`,
      MvpPlan,
      mvpPlanJsonSchema
    )
    yield* inputs.files.writeAtomic(
      cutPath(inputs.stateDir),
      encodeCut(answer.parked.map((story) => ParkedStory.make(story)))
    )
    // The id and the epic text are ours, whatever the model echoed back.
    return StoryPlan.make({ epicId: inputs.epicId, epic: inputs.epic, stories: answer.stories })
  })

const ParkedStories = Schema.fromJsonString(Schema.Array(ParkedStory))
const encodeCut = Schema.encodeSync(ParkedStories)
const decodeCut = Schema.decodeUnknownOption(ParkedStories)

export const cutPath = (stateDir: string): string => join(stateDir, "mvp-cut.json")

/** Every story keeps an MVP outcome; one with none belongs in the parked list. */
export const checkMvpPlan = (plan: StoryPlan): Effect.Effect<StoryPlan, StoryPlanInvalid> => {
  const violations = plan.stories
    .filter((story) => story.acceptance.length === 0)
    .map(
      (story) =>
        `story '${story.id}' has no MVP outcome in \`acceptance\`: give it one, or remove it and list it in mvp-cut.json`
    )
  return violations.length === 0
    ? Effect.succeed(plan)
    : Effect.fail(StoryPlanInvalid.make({ violations }))
}

// ---- Evidence ---------------------------------------------------------------

export const evidenceRequired = [
  "epic-mvp needs per-test evidence for each MVP outcome; set one of:",
  "  LLM4TS_TEST_REPORT=<path>   the JUnit XML report the test gate writes, relative to the app",
  "                              directory (vitest --reporter=junit --outputFile=…, jest-junit,",
  "                              pytest --junitxml=…, Surefire, cargo nextest)",
  "  LLM4TS_TEST_ONE=<command>   one test run per outcome, {tag} or {tagRegex} replaced by its tag",
  "                              (e.g. pnpm vitest run -t {tagRegex}); green when it exits 0"
].join("\n")

export const mvpPreflight = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<void, ScriptUsage> =>
  evidenceSourceFromEnvironment(environment) === undefined
    ? Effect.fail(ScriptUsage.make({ message: evidenceRequired }))
    : Effect.void

/**
 * The status of each tag in a checkout. `written(tag)` says the test sources
 * carry it, so a tag a report does not show (a suite that cannot load yet)
 * reads red rather than missing.
 */
export const evidenceAt = (
  source: EvidenceSource,
  unit: EpicUnitContext,
  workDir: string,
  tags: ReadonlyArray<string>,
  written: (tag: string) => boolean,
  events: FlowEventsShape,
  /** The checkout's uncommitted paths, to refuse a report git would commit. */
  uncommitted?: Effect.Effect<ReadonlyArray<string>, FlowError>
): Effect.Effect<ReadonlyMap<string, CriterionStatus>, FlowError> =>
  Effect.gen(function* () {
    const appRoot = join(workDir, unit.appDir)
    const statuses = new Map<string, CriterionStatus>()
    if (source._tag === "Report") {
      if (unit.testGate === undefined) {
        return yield* FlowAborted.make({
          message: `LLM4TS_TEST_REPORT is set but the gates name no test command to write it`
        })
      }
      const report = join(appRoot, source.path)
      yield* unit.files.remove(report)
      // Red is the point of a red phase: the gate's verdict is read from the report.
      yield* unit.testGate(workDir, events)
      const cases = parseJUnit((yield* unit.files.read(report)) ?? "")
      // A report git can see would be committed by a story and dirty the
      // epic checkout: it must be ignored, and it never outlives the read.
      const relative = join(unit.appDir, source.path)
      const visible = uncommitted === undefined ? false : (yield* uncommitted).includes(relative)
      yield* unit.files.remove(report)
      if (visible) {
        return yield* FlowAborted.make({
          message: `the test report ${relative} is not git-ignored: add it to .gitignore, then rerun`
        })
      }
      for (const tag of tags) {
        statuses.set(tag, statusFromReport(tag, cases, written(tag)))
      }
      return statuses
    }
    for (const tag of tags) {
      const result = yield* lintCommand(
        nodeProcessExecutor,
        events,
        commandFor(source.argv, tag),
        appRoot
      )
      statuses.set(tag, result.isClean ? "green" : written(tag) ? "red" : "missing")
    }
    return statuses
  })

// ---- The red phase ----------------------------------------------------------

export const redTestsPrompt = (story: Story, tags: ReadonlyArray<string>): string =>
  [
    `Red phase of the story "${story.title}" (test-first). Write ONLY tests now — no production code.`,
    "",
    "For each outcome below, write one or more tests whose NAME contains its tag exactly, for",
    'example it("[story-id#1] shows the balance", …). The tests assert the observable outcome and',
    "MUST FAIL now, because the behaviour does not exist yet; importing a module the story will",
    "create is fine. Put them in the story's owned test paths, beside the code they cover, in the",
    "repository's test style. Do not commit. Once written, these tests are frozen: the",
    "implementation will be judged by them alone.",
    "",
    ...story.acceptance.map((outcome, index) => `${tags[index] ?? ""} ${outcome}`)
  ].join("\n")

/** The one lens on the red tests: do they pin down the outcomes, and only them. */
export const redTestsLens = Reviewer.make({
  name: "red-tests",
  systemPrompt: [
    "You review tests written BEFORE the implementation, which will be the only check of it.",
    "For each tagged outcome, check that its tests assert the outcome itself (not an",
    "implementation detail), would fail on a wrong implementation, and cannot pass vacuously",
    "(no assertion, a mocked subject, a hard-coded expectation). Report only those gaps, one",
    "finding per gap, naming the tag. Production code is absent on purpose; never report that."
  ].join("\n"),
  screen: "The tests leave an outcome unasserted, assert a detail, or could pass vacuously."
})

const tagsWritten = (
  files: PlainFileStoreShape,
  workDir: string,
  paths: ReadonlyArray<string>
): Effect.Effect<string, PersistenceError> =>
  Effect.map(
    Effect.forEach(paths, (path) => files.read(join(workDir, path))),
    (texts) => texts.filter((text): text is string => text !== undefined).join("\n")
  )

/**
 * The story's red phase: the coder writes tagged tests, one review round
 * reads them, one fix turn answers it; every outcome must then be red. An
 * outcome with no tagged test after one more turn fails the story; one
 * whose tests already pass is parked as "check the outcome".
 */
export const mvpRedPhase =
  (source: EvidenceSource, unit: EpicUnitContext) =>
  (
    story: Story,
    seats: StorySeats,
    workDir: string,
    system: string,
    events: FlowEventsShape
  ): Effect.Effect<RedPhase, FlowError> =>
    Effect.gen(function* () {
      const git = seats.context.git
      const tags = criterionTags(story.id, story.acceptance)
      const chat = yield* makeChat(seats.context.coder, { system, events, agent: "coder" })
      yield* chat.ask(redTestsPrompt(story, tags))

      const reviewer = seats.context.roster?.forRole("reviewer") ?? seats.context.reasoning
      const review = yield* reviewWith(
        reviewer,
        events,
        redTestsLens,
        `red tests: ${story.title}`,
        yield* git.diffAll
      )
      if (!review.isClean) {
        yield* chat.ask(
          [
            "A reviewer read your tests. Fix these gaps in the tests (still no production code):",
            ...review.issues.map((issue) => `- ${issue.title}: ${issue.description}`)
          ].join("\n")
        )
      }

      const check = Effect.gen(function* () {
        const changed = testPaths(yield* git.uncommittedFiles)
        const text = yield* tagsWritten(unit.files, workDir, changed)
        const statuses = yield* evidenceAt(
          source,
          unit,
          workDir,
          tags,
          (tag) => text.includes(tag),
          events,
          git.uncommittedFiles
        )
        return { changed, statuses }
      })
      let seen = yield* check
      const missing = () => tags.filter((tag) => seen.statuses.get(tag) === "missing")
      if (missing().length > 0) {
        yield* chat.ask(
          `No test names these outcomes yet: ${missing().join(", ")}. Write them, with the tag in the test name.`
        )
        seen = yield* check
      }
      if (missing().length > 0) {
        return yield* StoryFailed.make({
          story: story.id,
          reason: `red phase: no test names ${missing().join(", ")}`
        })
      }
      const parked: Array<string> = []
      for (const [index, tag] of tags.entries()) {
        const status = seen.statuses.get(tag) ?? "missing"
        yield* events.publish(CriterionChecked.make({ story: story.id, tag, status }))
        if (status === "green") {
          const item = `${tag} ${story.acceptance[index] ?? ""}`
          const reason = "its tests pass before implementation: check the outcome or its test"
          parked.push(`${item} — ${reason}`)
          yield* events.publish(Parked.make({ story: story.id, item, reason, mvp: false }))
        }
      }
      return { frozen: seen.changed, parked }
    })

/** One green task per story: the tests are the plan. */
export const greenTaskPlan = (
  _seats: StorySeats,
  story: Story,
  _prompt: string
): Effect.Effect<Plan, FlowError> => {
  const tags = criterionTags(story.id, story.acceptance)
  return Effect.succeed(
    Plan.make({
      epicId: story.id,
      tasks: [
        Task.make({
          title: `Make the red tests of ${story.id} pass`,
          description: [
            "The tests tagged below are committed and frozen: make every one pass by writing the",
            "production code, inside your owned paths. Never change, skip or delete a frozen test.",
            ...story.acceptance.map((outcome, index) => `${tags[index] ?? ""} ${outcome}`),
            `Satisfies: ${story.acceptance.map((_, index) => index + 1).join(", ")}`
          ].join("\n")
        })
      ]
    })
  )
}

// ---- The verdict ------------------------------------------------------------

export interface ParkedEntry {
  readonly story: string
  readonly item: string
  readonly reason: string
  readonly mvp: boolean
}

export class MvpVerdict extends Schema.Class<MvpVerdict>("MvpVerdict")({
  reached: Schema.Boolean,
  green: Schema.Array(Schema.String),
  blocking: Schema.Array(Schema.String)
}) {}

export const MvpVerdictVersion = 1

export const verdictPath = (stateDir: string): string => join(stateDir, "mvp.json")
export const parkedPath = (stateDir: string): string => join(stateDir, "parked.md")

export const renderParked = (epicId: string, entries: ReadonlyArray<ParkedEntry>): string => {
  const blocking = entries.filter((entry) => entry.mvp)
  const later = entries.filter((entry) => !entry.mvp)
  const line = (entry: ParkedEntry) => `- **${entry.story}** — ${entry.item} _(${entry.reason})_`
  return [
    `# Parked: ${epicId}`,
    "",
    "What this iteration did not build. `--iterate` plans these as the next round;",
    "the text given with it picks which (none: all of them).",
    "",
    "## Blocking the MVP",
    "",
    ...(blocking.length === 0 ? ["(none)"] : blocking.map(line)),
    "",
    "## Later",
    "",
    ...(later.length === 0 ? ["(none)"] : later.map(line)),
    ""
  ].join("\n")
}

/**
 * What the unit left parked before evidence: stories cut whole, `later`
 * outcomes, outcomes the red phase found already green, and every MVP
 * outcome of a story that did not finish.
 */
export const parkedBeforeEvidence = (
  plan: StoryPlan,
  report: EpicReport,
  cut: ReadonlyArray<ParkedStory>,
  red: ReadonlyMap<string, RedTests>
): ReadonlyArray<ParkedEntry> => [
  ...cut.map((story) => ({
    story: story.title,
    item: "the whole story",
    reason: story.why,
    mvp: false
  })),
  ...plan.stories.flatMap((story) => {
    const outcome = report.stories.find((entry) => entry.id === story.id)
    const later = (story.later ?? []).map((item) => ({
      story: story.id,
      item,
      reason: "cut from this iteration",
      mvp: false
    }))
    const flagged = (red.get(story.id)?.parked ?? []).map((item) => ({
      story: story.id,
      item,
      reason: "already green",
      mvp: false
    }))
    const unfinished =
      outcome === undefined || outcome.status === "done"
        ? []
        : criterionTags(story.id, story.acceptance).map((tag, index) => ({
            story: story.id,
            item: `${tag} ${story.acceptance[index] ?? ""}`,
            reason: `story ${outcome.status}${outcome.reason === undefined ? "" : `: ${outcome.reason.split("\n")[0] ?? ""}`}`,
            mvp: true
          }))
    return [...later, ...flagged, ...unfinished]
  })
]

/**
 * After a unit: every finished story's MVP outcomes are checked on the epic
 * checkout. Reached when nothing MVP is parked and every one is green.
 */
export const mvpAfterUnit =
  (source: EvidenceSource) =>
  (unit: EpicUnitContext, report: EpicReport): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      const { files, events, plan } = unit
      const cut =
        unit.stateDir === unit.epicStateDir
          ? Option.getOrElse(
              decodeCut((yield* files.read(cutPath(unit.stateDir))) ?? "[]"),
              (): ReadonlyArray<ParkedStory> => []
            )
          : []
      const red = new Map<string, RedTests>()
      for (const story of plan.stories) {
        const tests = yield* loadVersioned(
          files,
          redTestsPath(unit.stateDir, story.id),
          RedTestsVersion,
          RedTests
        ).pipe(Effect.orElseSucceed(() => undefined))
        if (tests !== undefined) {
          red.set(story.id, tests)
        }
      }
      const done = plan.stories.filter(
        (story) => report.stories.find((entry) => entry.id === story.id)?.status === "done"
      )
      const tags = done.flatMap((story) =>
        criterionTags(story.id, story.acceptance).map((tag, index) => ({
          story,
          tag,
          outcome: story.acceptance[index] ?? ""
        }))
      )
      const statuses = yield* evidenceAt(
        source,
        unit,
        unit.workDir,
        tags.map((entry) => entry.tag),
        () => false,
        events
      )
      const notGreen: Array<ParkedEntry> = []
      const green: Array<string> = []
      for (const entry of tags) {
        const status = statuses.get(entry.tag) ?? "missing"
        yield* events.publish(
          CriterionChecked.make({ story: entry.story.id, tag: entry.tag, status })
        )
        if (status === "green") {
          green.push(entry.tag)
        } else {
          notGreen.push({
            story: entry.story.id,
            item: `${entry.tag} ${entry.outcome}`,
            reason: `${status} on the epic branch`,
            mvp: true
          })
        }
      }
      const entries = [...parkedBeforeEvidence(plan, report, cut, red), ...notGreen]
      for (const entry of entries) {
        yield* events.publish(Parked.make(entry))
      }
      const blocking = entries.filter((entry) => entry.mvp)
      const verdict = MvpVerdict.make({
        reached: blocking.length === 0,
        green,
        blocking: blocking.map((entry) => `${entry.story}: ${entry.item}`)
      })
      yield* files.writeAtomic(parkedPath(unit.stateDir), renderParked(plan.epicId, entries))
      yield* files.writeAtomic(verdictPath(unit.stateDir), encodeVerdict(verdict))
      yield* events.publish(
        Info.make({
          message: verdict.reached
            ? `MVP reached: ${green.length} outcome(s) green; ${entries.length} item(s) parked in ${parkedPath(unit.stateDir)} — --land when ready, --iterate for the next round`
            : `MVP not reached: ${blocking.length} MVP outcome(s) open, listed in ${parkedPath(unit.stateDir)}; rerun to finish the stories, or edit the plan`
        })
      )
    })

const Verdict = Schema.fromJsonString(MvpVerdict)
const encodeVerdict = Schema.encodeSync(Verdict)
const decodeVerdict = Schema.decodeUnknownOption(Verdict)

/** The state folders whose verdicts the landing reads: the epic's and each round's. */
const verdictDirs = (
  files: PlainFileStoreShape,
  epicStateDir: string
): Effect.Effect<ReadonlyArray<string>, PersistenceError> =>
  Effect.gen(function* () {
    const dirs = [epicStateDir]
    for (let round = 1; ; round += 1) {
      const dir = join(epicStateDir, "rounds", String(round))
      if ((yield* files.read(join(dir, "plan.md"))) === undefined) {
        return dirs
      }
      dirs.push(dir)
    }
  })

/** `--land` only once the MVP is reached, in the epic and in every round. */
export const mvpBeforeLand = (
  epicStateDir: string,
  files: PlainFileStoreShape
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    for (const dir of yield* verdictDirs(files, epicStateDir)) {
      const text = yield* files.read(verdictPath(dir))
      const verdict = text === undefined ? undefined : decodeVerdict(text)
      if (verdict === undefined || Option.isNone(verdict)) {
        return yield* FlowAborted.make({
          message: `not landing: ${dir} has no MVP verdict yet; run the epic first`
        })
      }
      if (!verdict.value.reached) {
        return yield* FlowAborted.make({
          message: [
            `not landing: the MVP is not reached (${verdictPath(dir)}). Open MVP outcomes:`,
            ...verdict.value.blocking.map((item) => `- ${item}`)
          ].join("\n")
        })
      }
    }
  })

/** `--iterate`: the text given, then every parked list of the epic as what to plan. */
export const mvpIterateFeedback = (
  epicStateDir: string,
  text: string,
  files: PlainFileStoreShape
): Effect.Effect<string, PersistenceError> =>
  Effect.gen(function* () {
    const parked: Array<string> = []
    for (const dir of yield* verdictDirs(files, epicStateDir)) {
      const list = yield* files.read(parkedPath(dir))
      if (list !== undefined) {
        parked.push(list)
      }
    }
    const pick =
      text.length === 0
        ? "Plan every parked item below as this round's MVP."
        : `Plan what the operator promotes:\n${text}\n\nThe parked items below are the context; plan only those the text names.`
    return parked.length === 0 ? text : [pick, "", ...parked].join("\n")
  })

// ---- The policy -------------------------------------------------------------

/** The epic-stories spine with epic-mvp's policy (ADR 0042). */
export const epicMvpOptions = (
  flags: MvpFlags,
  environment: Readonly<Record<string, string | undefined>>
): EpicStoriesOptions => {
  const source = evidenceSourceFromEnvironment(environment)
  return {
    preflight: mvpPreflight,
    generatePlan: generateMvpPlan,
    checkPlan: checkMvpPlan,
    refineFeedback: mvpIterateFeedback,
    beforeLand: mvpBeforeLand,
    ...(source === undefined
      ? {}
      : {
          stories: (unit: EpicUnitContext) => ({
            redPhase: mvpRedPhase(source, unit),
            planTasks: greenTaskPlan,
            // Green tests are the review; `--review` adds one lens back.
            reviewers: flags.review ? [correctnessReviewer] : [],
            taskConcurrency: 1
          }),
          afterUnit: mvpAfterUnit(source)
        })
  }
}
