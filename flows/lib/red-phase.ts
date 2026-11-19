// The red phase (ADR 0042, ADR 0053): before a story's tasks are planned,
// its coder writes tests for each acceptance criterion, one review round
// reads them, and the tests must fail. The executor commits them and freezes
// them. epic-mvp proves each criterion red with per-test evidence;
// epic-stories proves the story red with its test gate.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { makeChat } from "@llm4ts/flow/Chat"
import {
  FlowAborted,
  StoryFailed,
  type FlowError,
  type PersistenceError
} from "@llm4ts/flow/FlowError"
import { CriterionChecked, Info, Parked, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { lintCommand, reviewWith } from "@llm4ts/flow/Review"
import { Reviewer } from "@llm4ts/flow/Reviewer"
import type { RedPhase, StorySeats } from "@llm4ts/flow/Stories"
import type { Story } from "@llm4ts/flow/StoryPlan"
import {
  commandFor,
  criterionTags,
  parseJUnit,
  statusFromReport,
  testPaths,
  type CriterionStatus,
  type EvidenceSource
} from "@llm4ts/flow/TestEvidence"
import { nodeProcessExecutor } from "@llm4ts/runner"
import type { EpicUnitContext, StoriesPolicy } from "./epic-stories.ts"

// ---- Evidence ---------------------------------------------------------------

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

/**
 * Without per-test evidence: the test gate's one verdict for every tag the
 * tests carry. A failing gate reads red, a passing one green; with no test
 * gate the tests are not run and a written tag reads red, unproven.
 */
export const gateEvidence = (
  unit: EpicUnitContext,
  workDir: string,
  tags: ReadonlyArray<string>,
  written: (tag: string) => boolean,
  events: FlowEventsShape
): Effect.Effect<ReadonlyMap<string, CriterionStatus>, FlowError> =>
  Effect.gen(function* () {
    const verdict =
      unit.testGate === undefined
        ? "red"
        : (yield* unit.testGate(workDir, events)).isClean
          ? "green"
          : "red"
    return new Map(tags.map((tag) => [tag, written(tag) ? verdict : "missing"] as const))
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

/** How a flow holds a story to its red phase. */
export interface RedPhasePolicy {
  /** Per-test evidence (epic-mvp); absent, the test gate's verdict stands for every criterion. */
  readonly evidence: EvidenceSource | undefined
  /**
   * A criterion no test names fails the story (epic-mvp). Off, it is noted
   * and the story goes on; only a red phase that wrote no test fails it.
   */
  readonly strict: boolean
  /** A criterion green before implementation is parked for the operator (epic-mvp); off, noted. */
  readonly park: boolean
}

/**
 * The story's red phase: the coder writes tagged tests, one review round
 * reads them, one fix turn answers it, then the tests are run. A criterion
 * with no tagged test gets one more turn; one whose tests already pass is
 * parked or noted, as the policy says. The changed test files are frozen.
 */
export const redPhaseOf =
  (policy: RedPhasePolicy, unit: EpicUnitContext) =>
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
        const written = (tag: string) => text.includes(tag)
        const statuses =
          policy.evidence === undefined
            ? yield* gateEvidence(unit, workDir, tags, written, events)
            : yield* evidenceAt(
                policy.evidence,
                unit,
                workDir,
                tags,
                written,
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
      if (missing().length > 0 && (policy.strict || seen.changed.length === 0)) {
        return yield* StoryFailed.make({
          story: story.id,
          reason: policy.strict
            ? `red phase: no test names ${missing().join(", ")}`
            : "red phase: no test was written"
        })
      }
      if (missing().length > 0) {
        yield* events.publish(
          Info.make({
            message: `story ${story.id}: red phase: no test names ${missing().join(", ")}; the story goes on, the judge still scores its tests`
          })
        )
      }
      if (policy.evidence === undefined && unit.testGate === undefined) {
        yield* events.publish(
          Info.make({
            message: `story ${story.id}: red phase: the gates name no test command, so the red tests were written but not run`
          })
        )
      }
      const parked: Array<string> = []
      const green: Array<string> = []
      for (const [index, tag] of tags.entries()) {
        const status = seen.statuses.get(tag) ?? "missing"
        yield* events.publish(CriterionChecked.make({ story: story.id, tag, status }))
        if (status === "green") {
          const item = `${tag} ${story.acceptance[index] ?? ""}`
          const reason = "its tests pass before implementation: check the outcome or its test"
          green.push(tag)
          if (policy.park) {
            parked.push(`${item} — ${reason}`)
            yield* events.publish(Parked.make({ story: story.id, item, reason, mvp: false }))
          }
        }
      }
      if (!policy.park && green.length > 0) {
        yield* events.publish(
          Info.make({
            message: `story ${story.id}: red phase: the tests pass before implementation (${green.join(", ")}); they may not pin the new behaviour`
          })
        )
      }
      return { frozen: seen.changed, parked }
    })

/**
 * Whether a story gets a red phase under epic-stories: it names acceptance
 * criteria to test, its plan does not excuse it from tests, and its job is
 * not to rewrite existing tests.
 */
export const needsRedPhase = (story: Story): boolean =>
  story.acceptance.length > 0 && story.testsDeferred === undefined && !story.testsChange

/**
 * epic-stories' test-first policy (ADR 0053): the red phase for every story
 * that needs one, proved by the test gate, or per criterion when the
 * environment names per-test evidence. A missing tag or a test green too
 * early is noted, not fatal: the review and the judge still run.
 */
export const storiesTestFirst =
  (evidence: EvidenceSource | undefined) =>
  (unit: EpicUnitContext): StoriesPolicy => {
    const phase = redPhaseOf({ evidence, strict: false, park: false }, unit)
    return {
      redPhase: (story, seats, workDir, system, events) =>
        needsRedPhase(story)
          ? phase(story, seats, workDir, system, events)
          : Effect.succeed(noRedPhase)
    }
  }

const noRedPhase: RedPhase = { frozen: [], parked: [] }
