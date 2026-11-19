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
import type { FlowLlmError } from "@llm4ts/flow/FlowError"
import {
  FlowAborted,
  StoryPlanInvalid,
  type FlowError,
  type PersistenceError
} from "@llm4ts/flow/FlowError"
import { CriterionChecked, Info, Parked } from "@llm4ts/flow/FlowEvents"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { correctnessReviewer } from "@llm4ts/flow/Review"
import {
  RedTests,
  RedTestsVersion,
  redTestsPath,
  type EpicReport,
  type StorySeats
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  criterionTags,
  evidenceSourceFromEnvironment,
  type EvidenceSource
} from "@llm4ts/flow/TestEvidence"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { ScriptUsage } from "@llm4ts/runner"
import {
  storyJsonSchema,
  storyPlanInstructions,
  unitStateDirs,
  type EpicStoriesOptions,
  type EpicUnitContext,
  type PlanInputs
} from "./epic-stories.ts"
import { evidenceAt, redPhaseOf } from "./red-phase.ts"

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
    "- Leave `testsDeferred` out: every MVP story is written test-first.",
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

// ---- The red phase ----------------------------------------------------------

/**
 * The story's red phase under epic-mvp: per-test evidence, an outcome no
 * test names fails the story, one green before implementation is parked.
 */
export const mvpRedPhase = (source: EvidenceSource, unit: EpicUnitContext) =>
  redPhaseOf({ evidence: source, strict: true, park: true }, unit)

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

/** `--land` only once the MVP is reached, in the epic and in every round. */
export const mvpBeforeLand = (
  epicStateDir: string,
  files: PlainFileStoreShape
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    for (const dir of yield* unitStateDirs(files, epicStateDir)) {
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
    for (const dir of yield* unitStateDirs(files, epicStateDir)) {
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
