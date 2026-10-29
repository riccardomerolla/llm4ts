// Debt an epic run deferred and a later round pays (ADR 0043, ADR 0045):
// `debt.md` per unit, `debt.paid.md` once a hardening round settles, and
// the `--harden` policy both epic-draft and epic-stories use.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { FlowError, PersistenceError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { countNotPlanned } from "@llm4ts/flow/RefineRound"
import type { EpicReport } from "@llm4ts/flow/Stories"
import {
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
