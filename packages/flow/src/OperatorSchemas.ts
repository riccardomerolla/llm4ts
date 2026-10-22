import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AuthStatus, Availability } from "@llm4ts/core/Models"
import { BoardStatus } from "./BoardSync.ts"
import { CostReport } from "./CostReport.ts"
import { RunOutcome } from "./FlowRecorder.ts"
import { StoryStatus } from "./Stories.ts"

/** Where a run the operator started stands, as the registry last recorded it. */
export const OperatorRunState = Schema.Literals([
  "starting",
  "running",
  "exited",
  "interrupted",
  "lost"
])
export type OperatorRunState = typeof OperatorRunState.Type

/** The typed knobs a client may set when it starts a run; every one is optional. */
export const OperatorKnobs = Schema.Struct({
  task: Schema.optionalKey(Schema.String),
  epic: Schema.optionalKey(Schema.String),
  pack: Schema.optionalKey(Schema.String),
  executors: Schema.optionalKey(Schema.Array(Schema.String)),
  coder: Schema.optionalKey(Schema.String),
  judgeRounds: Schema.optionalKey(Schema.Int),
  mergeRevisions: Schema.optionalKey(Schema.Int),
  /** The branch to land. */
  land: Schema.optionalKey(Schema.String),
  flags: Schema.optionalKey(Schema.Array(Schema.String)),
  requestId: Schema.optionalKey(Schema.String)
})
export type OperatorKnobs = typeof OperatorKnobs.Type

/** One registry record: a run the operator started, appended on every state change. */
export class OperatorRun extends Schema.Class<OperatorRun>("OperatorRun")({
  runId: Schema.String,
  repo: Schema.String,
  flow: Schema.String,
  args: Schema.Array(Schema.String),
  knobs: OperatorKnobs,
  startedAt: Schema.Number,
  pid: Schema.optionalKey(Schema.Int),
  tracePath: Schema.optionalKey(Schema.String),
  logDir: Schema.String,
  state: OperatorRunState,
  exitCode: Schema.optionalKey(Schema.Int),
  signal: Schema.optionalKey(Schema.String),
  endedAt: Schema.optionalKey(Schema.Number),
  requestId: Schema.optionalKey(Schema.String)
}) {}

export const decodeOperatorRunLine = Schema.decodeUnknownOption(Schema.fromJsonString(OperatorRun))
export const encodeOperatorRunLine = Schema.encodeSync(Schema.fromJsonString(OperatorRun))

/** The last record per run, newest `startedAt` first; a line that does not decode is skipped. */
export const latestRuns = (lines: ReadonlyArray<string>): ReadonlyArray<OperatorRun> => {
  const byRun = new Map<string, OperatorRun>()
  for (const line of lines) {
    if (line.trim().length === 0) continue
    for (const run of Option.toArray(decodeOperatorRunLine(line))) byRun.set(run.runId, run)
  }
  return [...byRun.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export const LaneStatusOut = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["running", "done", "failed"]),
  stage: Schema.optionalKey(Schema.String),
  executor: Schema.optionalKey(Schema.String),
  activity: Schema.optionalKey(Schema.String),
  lastEventAgeMs: Schema.Int,
  costUsd: Schema.Number
})
export type LaneStatusOut = typeof LaneStatusOut.Type

export class RunStatus extends Schema.Class<RunStatus>("RunStatus")({
  runId: Schema.String,
  state: OperatorRunState,
  ended: Schema.optionalKey(RunOutcome),
  elapsedMs: Schema.Int,
  lanes: Schema.Array(LaneStatusOut),
  stories: Schema.Array(Schema.Struct({ id: Schema.String, status: BoardStatus })),
  tokens: Schema.Int,
  costUsd: Schema.Number,
  warnings: Schema.Array(Schema.String),
  seq: Schema.Int,
  summary: Schema.String
}) {}

export const MeaningfulEvent = Schema.Struct({
  seq: Schema.Int,
  at: Schema.Number,
  kind: Schema.String,
  lane: Schema.optionalKey(Schema.String),
  text: Schema.String
})
export type MeaningfulEvent = typeof MeaningfulEvent.Type

export class RunWaitResult extends Schema.Class<RunWaitResult>("RunWaitResult")({
  events: Schema.Array(MeaningfulEvent),
  seq: Schema.Int,
  ended: Schema.optionalKey(RunOutcome),
  exited: Schema.Boolean,
  summary: Schema.String
}) {}

export const ConnectorHealthOut = Schema.Struct({
  id: Schema.String,
  availability: Availability,
  authStatus: AuthStatus,
  // "auth": the CLI's own login check answered; "version": only `--version`
  // ran, which proves no live login; "unknown": nothing more can be said.
  probe: Schema.Literals(["version", "auth", "unknown"]),
  latencyMs: Schema.optionalKey(Schema.Int)
})
export type ConnectorHealthOut = typeof ConnectorHealthOut.Type

export const ExecutorHealthOut = Schema.Struct({
  id: Schema.String,
  harness: Schema.String,
  roles: Schema.Array(Schema.String),
  disabled: Schema.Boolean,
  healthy: Schema.optionalKey(Schema.Boolean)
})
export type ExecutorHealthOut = typeof ExecutorHealthOut.Type

export class PreflightResult extends Schema.Class<PreflightResult>("PreflightResult")({
  llm4ts: Schema.String,
  node: Schema.String,
  connectors: Schema.Array(ConnectorHealthOut),
  executors: Schema.Array(ExecutorHealthOut),
  notes: Schema.Array(Schema.String)
}) {}

export class StoryDetail extends Schema.Class<StoryDetail>("StoryDetail")({
  id: Schema.String,
  title: Schema.String,
  state: Schema.optionalKey(
    Schema.Struct({
      status: StoryStatus,
      branch: Schema.String,
      worktree: Schema.String,
      executor: Schema.optionalKey(Schema.String)
    })
  ),
  board: Schema.optionalKey(
    Schema.Struct({ status: BoardStatus, detail: Schema.optionalKey(Schema.String) })
  ),
  tasks: Schema.Array(Schema.Struct({ title: Schema.String, completed: Schema.Boolean })),
  findings: Schema.optionalKey(Schema.String),
  verdict: Schema.optionalKey(Schema.Json),
  gateLogs: Schema.Array(Schema.String)
}) {}

export class Diagnosis extends Schema.Class<Diagnosis>("Diagnosis")({
  runId: Schema.String,
  story: Schema.optionalKey(Schema.String),
  digest: Schema.String,
  failure: Schema.optionalKey(
    Schema.Struct({
      stage: Schema.optionalKey(Schema.String),
      message: Schema.String,
      lane: Schema.optionalKey(Schema.String)
    })
  ),
  gateLogTails: Schema.Array(Schema.Struct({ path: Schema.String, tail: Schema.String })),
  transcriptTail: Schema.Array(Schema.String)
}) {}

export class CostsOut extends Schema.Class<CostsOut>("CostsOut")({
  report: CostReport,
  total: Schema.Number,
  ledger: Schema.optionalKey(Schema.Number),
  differs: Schema.Boolean
}) {}

export class UnknownRepo extends Schema.TaggedError<UnknownRepo>()("UnknownRepo", {
  message: Schema.String
}) {}

export class UnknownRun extends Schema.TaggedError<UnknownRun>()("UnknownRun", {
  message: Schema.String
}) {}

export class UnknownStory extends Schema.TaggedError<UnknownStory>()("UnknownStory", {
  message: Schema.String
}) {}

export class UnknownFlow extends Schema.TaggedError<UnknownFlow>()("UnknownFlow", {
  message: Schema.String
}) {}

export class NotAllowed extends Schema.TaggedError<NotAllowed>()("NotAllowed", {
  message: Schema.String
}) {}

/** A start knob that would reach the flow's argv or environment in an unsafe shape. */
export class InvalidKnob extends Schema.TaggedError<InvalidKnob>()("InvalidKnob", {
  knob: Schema.String,
  message: Schema.String
}) {}

export class RunInProgress extends Schema.TaggedError<RunInProgress>()("RunInProgress", {
  message: Schema.String,
  runId: Schema.String
}) {}

/** An epic id that is not a folder under the repository's `.llm4ts/epics/`. */
export class UnknownEpic extends Schema.TaggedError<UnknownEpic>()("UnknownEpic", {
  message: Schema.String
}) {}

/** A state file that exists but could not be read or parsed; the message names its path. */
export class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
  message: Schema.String
}) {}
