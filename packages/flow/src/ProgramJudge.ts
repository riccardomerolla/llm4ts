import * as Effect from "effect/Effect"
import { Sample, type Dimension, type EvalResult } from "@llm4ts/core/eval/Eval"
import type { Evaluator } from "@llm4ts/core/eval/Evaluator"
import { capped, withShrink } from "./Context.ts"
import { FlowLlmError, type FlowError } from "./FlowError.ts"
import { FlowEvents, Info } from "./FlowEvents.ts"
import type { GitToolShape } from "./GitTool.ts"
import type { Pack } from "./Pack.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { ReviewIssue, ReviewResult, mergeReviewResults } from "./Review.ts"
import { cachedReview } from "./ReviewCache.ts"

// Per-program spec-compliance judging, shared by the implement and review
// phases. A whole-branch judge call carries every spec and every diff hunk in
// the estate, which is what blows a provider's input window. Judging one
// program at a time against only that program's slice of the diff keeps each
// call small, and — wrapped in the review cache — makes the gate resumable: an
// unchanged program reuses its stored verdict with no LLM call.

export interface GroupedFiles {
  readonly byProgram: Readonly<Record<string, ReadonlyArray<string>>>
  readonly unassigned: ReadonlyArray<string>
}

/**
 * Partition `changed` by which program's file regex matches. A file matching
 * several programs is judged with each of them (a shared bridge class is
 * genuinely part of both). The remainder — build files, shared utilities — is
 * returned separately for the unassigned pass.
 */
export const groupFiles = (
  pack: Pack,
  programs: ReadonlyArray<string>,
  changed: ReadonlyArray<string>
): GroupedFiles => {
  const byProgram = Object.fromEntries(
    programs.map((program) => {
      const matches = pack.filesFor(program)
      return [program, changed.filter((file) => matches.test(file))] as const
    })
  )
  const assigned = new Set(Object.values(byProgram).flat())
  return {
    byProgram,
    unassigned: changed.filter((file) => !assigned.has(file))
  }
}

export interface ProgramJudgeOptions {
  readonly pack: Pack
  readonly judge: Evaluator<Sample>
  readonly dimensions: ReadonlyArray<Dimension>
  readonly git: GitToolShape
  readonly files: PlainFileStoreShape
  /** Directory holding the per-program verdict cache (`<gateDir>/<NAME>.json`). */
  readonly gateDir: string
  readonly base: string
  readonly programs: ReadonlyArray<string>
  /** A program's spec text; the caller owns where specs live. */
  readonly specFor: (program: string) => Effect.Effect<string, FlowError>
  readonly query: string
  /** Content fingerprint for the verdict cache (hashing lives outside flow). */
  readonly fingerprint: (...parts: ReadonlyArray<string>) => string
}

const join = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`

const rubricText = (dimensions: ReadonlyArray<Dimension>): string =>
  dimensions
    .map((dimension) => `${dimension.name} (0..${dimension.maxScore}): ${dimension.rubric}`)
    .join("\n")

/**
 * Sub-bar dimensions as Critical review issues, titled with the program they
 * belong to — the same shape the extract gate produces, so fix loops and
 * `ReviewResult.isClean` work unchanged.
 */
const issues = (
  scored: EvalResult,
  dimensions: ReadonlyArray<Dimension>,
  program: string
): ReviewResult => {
  const subBar = scored.scores.filter(
    (score) =>
      score.score < (dimensions.find((dimension) => dimension.name === score.name)?.maxScore ?? 2)
  )
  return ReviewResult.make({
    issues: subBar.map((score) =>
      ReviewIssue.make({
        severity: "Critical",
        title: `judge[${program}]: ${score.name} scored ${score.score}`,
        description: score.reasoning
      })
    ),
    summary: `judge:${program}`
  })
}

/**
 * A spec'd program with NO matching changed file is a deterministic gate
 * failure, not a silent pass. Skipping it would let the branch clear a bar the
 * old whole-branch judge would have failed. It also surfaces a mis-set
 * `programFiles:` immediately — the top documented risk of the per-program
 * design — instead of quietly degrading coverage.
 */
export const unimplemented = (programs: ReadonlyArray<string>): ReviewResult =>
  ReviewResult.make({
    issues: programs.map((program) =>
      ReviewIssue.make({
        severity: "Critical",
        title: `judge[${program}]: spec'd but no implementation files changed`,
        description:
          `${program} has a committed spec but no file on this branch matches the pack's ` +
          "programFiles regex for it. Either the program is unimplemented, or the pack's " +
          "`programFiles:` template does not match this repo's layout — check that before " +
          "assuming the former."
      })
    ),
    summary: "judge:unimplemented"
  })

const judgeSlice = Effect.fn("@llm4ts/flow/ProgramJudge.judgeSlice")(function* (
  options: ProgramJudgeOptions,
  label: string,
  spec: string,
  diff: string
): Effect.fn.Return<ReviewResult, FlowError, FlowEvents> {
  const events = yield* FlowEvents
  const rubric = rubricText(options.dimensions)
  return yield* cachedReview(
    options.files,
    join(options.gateDir, `${label}.json`),
    options.fingerprint(spec, diff, rubric),
    events.publish(Info.make({ message: `judging ${label}` })).pipe(
      Effect.andThen(
        withShrink(`judge[${label}]`, (cap) =>
          Effect.gen(function* () {
            const cappedSpec = yield* capped(`spec[${label}]`, spec, cap)
            const cappedDiff = yield* capped(`diff[${label}]`, diff, cap)
            return yield* options.judge
              .evaluate(
                Sample.make({ response: cappedDiff, context: cappedSpec, query: options.query })
              )
              .pipe(Effect.mapError(FlowLlmError.from))
          })
        )
      ),
      Effect.map((scored) => issues(scored, options.dimensions, label))
    )
  )
})

/**
 * Judge every program whose files changed, plus one pass over the unassigned
 * remainder. Each verdict is cached at `gateDir/<NAME>.json`, fingerprinted
 * over the spec, the diff slice, and the rubric it judged — so re-running
 * after a crash re-judges only what changed.
 */
export const judgeAllPrograms = Effect.fn("@llm4ts/flow/ProgramJudge.judgeAll")(function* (
  options: ProgramJudgeOptions
): Effect.fn.Return<ReviewResult, FlowError, FlowEvents> {
  const changed = yield* options.git.changedFilesVsBase(options.base)
  const { byProgram, unassigned } = groupFiles(options.pack, options.programs, changed)
  const active = options.programs.filter((program) => (byProgram[program] ?? []).length > 0)
  const untouched = options.programs.filter((program) => (byProgram[program] ?? []).length === 0)

  const perProgram: Array<ReviewResult> = []
  for (const program of active) {
    const spec = yield* options.specFor(program)
    // The file slice comes from groupFiles — re-deriving it per program would
    // be N+1 git invocations for the same answer.
    const diff = yield* options.git.diffVsBaseScoped(options.base, byProgram[program] ?? [])
    perProgram.push(yield* judgeSlice(options, program, spec, diff))
  }

  if (unassigned.length > 0) {
    const diff = yield* options.git.diffVsBaseScoped(options.base, unassigned)
    const specs = yield* Effect.forEach(options.programs, options.specFor).pipe(
      Effect.map((all) => all.join("\n\n"))
    )
    perProgram.push(yield* judgeSlice(options, "unassigned", specs, diff))
  }

  return mergeReviewResults([...perProgram, unimplemented(untouched)])
})
