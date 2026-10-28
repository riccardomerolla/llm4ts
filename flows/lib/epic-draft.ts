// epic-draft (ADR 0043): the epic-stories spine with tests and validation
// deferred, not dropped. A draft run plans and builds without tests, under
// one review lens and the build gates; what it deferred is written to
// debt.md, and `--harden` plans that debt as a round under the full bar.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { FlowError, FlowLlmError, PersistenceError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { failingLinesOf } from "@llm4ts/flow/GateTriage"
import { countNotPlanned } from "@llm4ts/flow/RefineRound"
import { correctnessReviewer } from "@llm4ts/flow/Review"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { deferredPath, EpicReport } from "@llm4ts/flow/Stories"
import { StoryPlan } from "@llm4ts/flow/StoryPlan"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import {
  loadRounds,
  rubricStoryJudge,
  storyPlanInstructions,
  storyPlanJsonSchema,
  unitStateDirs,
  withoutTestGate,
  type EpicStoriesOptions,
  type EpicUnitContext,
  type PlanInputs
} from "./epic-stories.ts"

// ---- Flags ------------------------------------------------------------------

export interface DraftFlags {
  /** `--harden`: plan the epic's open debt (and the text given) as a round under the full bar. */
  readonly harden: boolean
  /** `--with-tests`: keep the test gate while drafting. */
  readonly withTests: boolean
  /** Everything else, for epic-stories' own flags (`--harden` becomes `--refine`). */
  readonly argv: ReadonlyArray<string>
}

export const parseDraftFlags = (argv: ReadonlyArray<string>): DraftFlags => {
  const harden = argv.includes("--harden")
  const withTests = argv.includes("--with-tests")
  const rest = argv.filter((arg) => arg !== "--harden" && arg !== "--with-tests")
  return { harden, withTests, argv: harden ? ["--refine", ...rest] : rest }
}

// ---- The draft plan ---------------------------------------------------------

/** The epic-stories planner's rules, then the draft cut on top. */
export const draftPlanInstructions = (
  epicId: string,
  guidance: string,
  orientation?: string
): string =>
  [
    storyPlanInstructions(epicId, guidance, orientation),
    "",
    "Draft cut (this run is epic-draft: working code first, tests and validation in a later",
    "hardening round). These rules override the ones above where they differ:",
    "- No story writes or owns test files now; leave them out of `owned`.",
    "- `acceptance` still lists two to six outcomes per story: each one is a test the hardening",
    "  round will write, so make each checkable by an automated test.",
    "- Prefer fewer, thinner stories: the shortest path to working code.",
    "- Leave `testsDeferred` out: every outcome's test is owed and planned later."
  ].join("\n")

/** The draft planner: the epic-stories plan under the draft cut. */
export const generateDraftPlan = (inputs: PlanInputs): Effect.Effect<StoryPlan, FlowLlmError> =>
  structuredAndPublish(
    inputs.reasoning,
    inputs.events,
    `${draftPlanInstructions(inputs.epicId, inputs.guidance, inputs.orientation)}\n\nEpic:\n${inputs.brief ?? inputs.epic}`,
    StoryPlan,
    storyPlanJsonSchema
  ).pipe(
    // The id and the epic text are ours, whatever the model echoed back.
    Effect.map((plan) => StoryPlan.make({ ...plan, epicId: inputs.epicId, epic: inputs.epic }))
  )

// ---- The debt ---------------------------------------------------------------

/** What a draft unit deferred: the tests owed, the findings, the skipped test gate. */
export const debtPath = (stateDir: string): string => join(stateDir, "debt.md")

/** Debt a settled hardening round consumed. */
export const paidPath = (stateDir: string): string => join(stateDir, "debt.paid.md")

const merged = (plan: StoryPlan, report: EpicReport) =>
  plan.stories.filter((story) =>
    report.stories.some((outcome) => outcome.id === story.id && outcome.status === "done")
  )

export const renderDebt = (
  plan: StoryPlan,
  report: EpicReport,
  deferred: string | undefined,
  testFailures: string | undefined
): string =>
  [
    `# Debt — ${plan.epicId}`,
    "",
    ...merged(plan, report).flatMap((story) => [
      `## ${story.id}`,
      "",
      ...story.acceptance.map((outcome) => `- [ ] test: ${outcome}`),
      ""
    ]),
    ...(deferred === undefined ? [] : ["## Deferred findings", "", deferred, ""]),
    ...(testFailures === undefined
      ? []
      : ["## Test gate on the epic checkout (skipped while drafting)", "", testFailures, ""])
  ].join("\n")

const counted = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * After a draft unit: `debt.md` with the merged stories' owed tests, their
 * deferred findings and, when the draft skipped it, one run of the test gate
 * on the epic checkout — gates with a memory would otherwise call those
 * failures inherited and never charge a hardening story with them.
 */
export const draftAfterUnit =
  (withTests: boolean) =>
  (unit: EpicUnitContext, report: EpicReport): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      // A story whose debt a hardening round already paid owes nothing again.
      const paid = new Set(
        ((yield* unit.files.read(paidPath(unit.stateDir))) ?? "")
          .split("\n")
          .flatMap((line) => (line.startsWith("## ") ? [line.slice(3).trim()] : []))
      )
      const stories = merged(unit.plan, report).filter((story) => !paid.has(story.id))
      const findings: Array<string> = []
      for (const story of stories) {
        const text = yield* unit.files.read(deferredPath(unit.stateDir, story.id))
        findings.push(...(text ?? "").split("\n").filter((line) => line.startsWith("- [")))
      }
      const gate =
        withTests || unit.testGate === undefined
          ? undefined
          : yield* unit.testGate(unit.workDir, unit.events)
      // The failing lines alone: a test run's whole output would crowd the planner's prompt.
      const failing =
        gate === undefined || gate.issues.length === 0
          ? []
          : failingLinesOf(gate, [unit.workDir]).map((line) => `- ${line}`)
      const testFailures =
        gate === undefined || gate.issues.length === 0
          ? undefined
          : (failing.length > 0 ? failing : gate.issues.map((issue) => `- ${issue.title}`)).join(
              "\n"
            )
      const owed = stories.reduce((sum, story) => sum + story.acceptance.length, 0)
      if (owed === 0 && findings.length === 0 && testFailures === undefined) {
        return
      }
      const path = debtPath(unit.stateDir)
      yield* unit.files.writeAtomic(
        path,
        renderDebt(
          unit.plan,
          EpicReport.make({
            ...report,
            stories: report.stories.filter((outcome) => !paid.has(outcome.id))
          }),
          findings.length === 0 ? undefined : findings.join("\n"),
          testFailures
        )
      )
      yield* unit.events.publish(
        Info.make({
          message: `debt: ${counted(owed, "test owed", "tests owed")}, ${
            findings.length === 0
              ? "no deferred findings"
              : counted(findings.length, "deferred finding", "deferred findings")
          }${testFailures === undefined ? "" : ", test gate red"} — run epic-draft --harden (${path})`
        })
      )
    })

// ---- Hardening --------------------------------------------------------------

/** The open debt lists of an epic, by state folder; empty ones are paid. */
const openDebt = (
  files: PlainFileStoreShape,
  epicStateDir: string
): Effect.Effect<
  ReadonlyArray<{ readonly dir: string; readonly text: string }>,
  PersistenceError
> =>
  Effect.gen(function* () {
    const open: Array<{ readonly dir: string; readonly text: string }> = []
    for (const dir of yield* unitStateDirs(files, epicStateDir)) {
      const text = (yield* files.read(debtPath(dir)))?.trim() ?? ""
      if (text.length > 0) {
        open.push({ dir, text })
      }
    }
    return open
  })

/** `--harden`: the text given, then every open debt list, as the round to plan. */
export const hardenFeedback = (
  epicStateDir: string,
  text: string,
  files: PlainFileStoreShape
): Effect.Effect<string, PersistenceError> =>
  Effect.gen(function* () {
    // An open round finishes before another is planned: with text, runAction would refuse it.
    const rounds = yield* loadRounds(files, epicStateDir).pipe(
      Effect.catch(() => Effect.succeed([]))
    )
    const last = rounds.at(-1)
    if (last?.plan !== undefined && last.merged < last.plan.stories.length) {
      return text
    }
    const open = yield* openDebt(files, epicStateDir)
    return open.length === 0
      ? text
      : [
          "Pay this epic's draft debt: write the tests owed as deterministic tests in the house",
          "style, make the test gate green, and close the findings that still apply.",
          ...(text.length === 0 ? [] : ["", text]),
          "",
          ...open.flatMap((debt) => [debt.text, ""])
        ].join("\n")
  })

/** After a hardening round that settled (nothing failed or waiting), its debt is paid. */
export const hardenAfterUnit = (
  unit: EpicUnitContext,
  report: EpicReport
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    if (report.count("failed") > 0 || report.count("waiting") > 0) {
      return
    }
    for (const debt of yield* openDebt(unit.files, unit.epicStateDir)) {
      const paid = (yield* unit.files.read(paidPath(debt.dir))) ?? ""
      yield* unit.files.writeAtomic(paidPath(debt.dir), `${paid}${debt.text}\n`)
      yield* unit.files.writeAtomic(debtPath(debt.dir), "")
    }
    // What the round's planner left out is listed, never carried (ADR 0031 decision 6).
    const notPlannedPath = join(unit.stateDir, "not-planned.md")
    const left = countNotPlanned((yield* unit.files.read(notPlannedPath)) ?? "")
    if (left > 0) {
      yield* unit.events.publish(
        Info.make({
          message: `harden: ${counted(left, "debt item was", "debt items were")} not planned (${notPlannedPath}); pass them to --harden as text if they still matter`
        })
      )
    }
  })

// ---- The policy -------------------------------------------------------------

/**
 * The epic-stories spine with epic-draft's policy (ADR 0043). A draft defers
 * tests and validation; `--harden` runs epic-stories' own bar over the debt.
 */
export const epicDraftOptions = (flags: DraftFlags): EpicStoriesOptions =>
  flags.harden
    ? {
        storyJudge: rubricStoryJudge,
        refineFeedback: hardenFeedback,
        afterUnit: hardenAfterUnit
      }
    : {
        generatePlan: generateDraftPlan,
        stories: () => ({
          reviewers: [correctnessReviewer],
          maxRounds: 1,
          deferNonBlocking: true
        }),
        ...(flags.withTests ? {} : { selectGates: withoutTestGate }),
        afterUnit: draftAfterUnit(flags.withTests)
      }
