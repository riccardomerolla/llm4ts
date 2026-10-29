// Debt an epic run deferred and a later round pays (ADR 0043, ADR 0045):
// `debt.md` per unit, `debt.paid.md` once a hardening round settles, and
// the `--harden` policy both epic-draft and epic-stories use.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { FlowError, PersistenceError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { countNotPlanned } from "@llm4ts/flow/RefineRound"
import { lastStoryVerdict, type EpicReport } from "@llm4ts/flow/Stories"
import { ScriptUsage } from "@llm4ts/runner"
import {
  deferringTestsJudge,
  epicUsage,
  loadRounds,
  rubricStoryJudge,
  unitStateDirs,
  type EpicStoriesOptions,
  type EpicUnitContext
} from "./epic-stories.ts"

// ---- The debt ---------------------------------------------------------------

export const counted = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** What a unit deferred: the tests owed, the findings, the test gate it skipped. */
export const debtPath = (stateDir: string): string => join(stateDir, "debt.md")

/** Debt a settled hardening round consumed. */
export const paidPath = (stateDir: string): string => join(stateDir, "debt.paid.md")

// ---- Tests the judge excused (ADR 0045) -------------------------------------

/**
 * After an epic-stories unit run with `--defer-tests`: `debt.md` with one
 * section per merged story whose last verdict scored `tests` below the bar,
 * each acceptance outcome a test owed. A story the plan exempts from tests,
 * or one a hardening round paid, owes nothing. Deferred findings are left
 * out: `--defer-findings` already plans them as their own round.
 */
export const testsDebtAfterUnit = (
  unit: EpicUnitContext,
  report: EpicReport
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    const paid = new Set(
      ((yield* unit.files.read(paidPath(unit.stateDir))) ?? "")
        .split("\n")
        .flatMap((line) => (line.startsWith("## ") ? [line.slice(3).trim()] : []))
    )
    const sections: Array<string> = []
    let owed = 0
    let stories = 0
    for (const story of unit.plan.stories) {
      const merged = report.stories.some(
        (outcome) => outcome.id === story.id && outcome.status === "done"
      )
      if (!merged || story.testsDeferred !== undefined || paid.has(story.id)) {
        continue
      }
      const verdict = yield* lastStoryVerdict(unit.files, unit.stateDir, story.id)
      const tests = verdict?.excused?.find((dimension) => dimension.id === "tests")
      if (tests === undefined) {
        continue
      }
      owed += story.acceptance.length
      stories += 1
      sections.push(
        `## ${story.id}`,
        "",
        `judge scored tests ${tests.score}/${tests.max}: ${tests.reasoning}`,
        "",
        ...story.acceptance.map((outcome) => `- [ ] test: ${outcome}`),
        ""
      )
    }
    if (stories === 0) {
      return
    }
    const path = debtPath(unit.stateDir)
    yield* unit.files.writeAtomic(
      path,
      [`# Debt — ${unit.plan.epicId}`, "", ...sections].join("\n")
    )
    yield* unit.events.publish(
      Info.make({
        message: `debt: ${counted(owed, "test owed", "tests owed")} by ${counted(stories, "story", "stories")} — read it, then run epic-stories --harden (${path})`
      })
    )
  })

// ---- Hardening --------------------------------------------------------------

/** The open debt lists of an epic, by state folder; empty ones are paid. */
export const openDebt = (
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
          "Pay this epic's debt: write the tests owed as deterministic tests in the house",
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

/** `--harden`: the open debt planned as a round under epic-stories' full bar. */
export const hardenOptions: EpicStoriesOptions = {
  storyJudge: rubricStoryJudge,
  refineFeedback: hardenFeedback,
  afterUnit: hardenAfterUnit
}

// ---- epic-stories' flags ----------------------------------------------------

export interface StoriesFlags {
  /** `--defer-tests` (or LLM4TS_DEFER_TESTS): the judge's tests score becomes debt (ADR 0045). */
  readonly deferTests: boolean
  /** `--harden`: plan the epic's open debt as a round under the full bar. */
  readonly harden: boolean
  /** Everything else, for the spine's own flags (`--harden` becomes `--refine`). */
  readonly argv: ReadonlyArray<string>
}

export const parseStoriesFlags = (
  argv: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<StoriesFlags, ScriptUsage> =>
  Effect.gen(function* () {
    const deferTests =
      argv.includes("--defer-tests") ||
      /^(1|true|on|yes)$/i.test(environment.LLM4TS_DEFER_TESTS?.trim() ?? "")
    const harden = argv.includes("--harden")
    if (deferTests && harden) {
      return yield* ScriptUsage.make({
        message: `--harden pays the debt under the full bar; it does not take --defer-tests (or LLM4TS_DEFER_TESTS)\n${epicUsage}`
      })
    }
    const rest = argv.filter((arg) => arg !== "--defer-tests" && arg !== "--harden")
    return { deferTests, harden, argv: harden ? ["--refine", ...rest] : rest }
  })

/** epic-stories' policy for its flags: the rubric judge, excusing tests, or hardening. */
export const epicStoriesOptions = (flags: StoriesFlags): EpicStoriesOptions =>
  flags.harden
    ? hardenOptions
    : flags.deferTests
      ? {
          storyJudge: deferringTestsJudge,
          stories: () => ({ judgeBar: "defer-tests" }),
          afterUnit: testsDebtAfterUnit
        }
      : { storyJudge: rubricStoryJudge }
