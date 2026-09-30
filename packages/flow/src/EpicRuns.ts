import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

/**
 * Every run that touched an epic, with the trace it wrote (ADR 0022): one
 * JSON line per run in the epic's folder, so `llm4ts watch --epic` opens the
 * latest run and a reader can reach every run, restarts included.
 */
export class EpicRun extends Schema.Class<EpicRun>("EpicRun")({
  runId: Schema.String,
  tracePath: Schema.String,
  /** What the run set out to do (`runAction`: RunPlan, RunRound, PlanRound, Land). */
  action: Schema.String,
  /** The refine round it runs or plans, when it is one. */
  round: Schema.optionalKey(Schema.Int),
  startedAt: Schema.Number
}) {}

export const epicRunsPath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/runs.jsonl`

const encodeRun = Schema.encodeSync(Schema.fromJsonString(EpicRun))
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(EpicRun))

export const appendEpicRun = (
  files: PlainFileStoreShape,
  stateDir: string,
  run: EpicRun
): Effect.Effect<void, PersistenceError> =>
  files.append(epicRunsPath(stateDir), `${encodeRun(run)}\n`)

/** The epic's runs, oldest first; a line that does not decode (a torn write) is skipped. */
export const readEpicRuns = (
  files: PlainFileStoreShape,
  stateDir: string
): Effect.Effect<ReadonlyArray<EpicRun>, PersistenceError> =>
  Effect.map(files.read(epicRunsPath(stateDir)), (contents) =>
    (contents ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => Option.toArray(decodeRun(line)))
  )
