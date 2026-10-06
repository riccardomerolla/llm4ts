// The target's gates as a module (ADR 0027): run them in a directory with a
// timeout and a log per gate, remember what they said on a base, and keep
// only what matters when an epic lands. The pure half lives in
// GateTriage.ts and is re-exported here.
import { join } from "node:path"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { baselinesPath, normalizeGateOutput } from "./GateTriage.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { lintCommand, mergeReviewResults, type ReviewResult } from "./Review.ts"

export * from "./GateTriage.ts"

export interface GateLogDir {
  readonly files: PlainFileStoreShape
  readonly dir: string
}

export interface GateRunOptions {
  readonly timeout?: Duration.Duration
  /** Where this runner's logs go unless a call names its own; `undefined` writes none. */
  readonly logDir?: GateLogDir
}

/** `<index>-<command slug>.log`: one file per gate command, overwritten each run. */
export const gateLogName = (index: number, command: ReadonlyArray<string>): string =>
  `${index}-${command
    .join(" ")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase()}.log`

/** Runs the gates in a directory, stopping at the first red one (later output would be noise). */
export const gatesIn =
  (
    process: ProcessExecutorShape,
    events: FlowEventsShape,
    commands: ReadonlyArray<ReadonlyArray<string>>,
    options: GateRunOptions = {}
  ) =>
  (
    workDir: string,
    laneEvents?: FlowEventsShape,
    log?: GateLogDir
  ): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const sink = log ?? options.logDir
      const results: Array<ReviewResult> = []
      for (const [index, command] of commands.entries()) {
        const result = yield* lintCommand(process, laneEvents ?? events, command, workDir, {
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(sink === undefined
            ? {}
            : { log: { files: sink.files, path: join(sink.dir, gateLogName(index, command)) } })
        })
        results.push(result)
        if (!result.isClean) {
          break
        }
      }
      return mergeReviewResults(results)
    })

/** A landed epic keeps why a gate was red, not the target's whole test output. */
export const compactGateLog = (text: string, roots: ReadonlyArray<string>): string =>
  normalizeGateOutput(text, roots).join("\n")

/** The gate log directory of one story under a run's state folder. */
export const storyGateLogDir = (stateDir: string, storyId: string): string =>
  join(stateDir, "stories", storyId, "gates")

/**
 * What `--land` keeps of the gates: no baselines (reproducible), and each
 * story's gate logs reduced to their failing lines. Logs are enumerated from
 * the story ids and the gate commands, so no listing is needed.
 */
export const compactGateArtifacts = Effect.fn("@llm4ts/flow/Gates.compactArtifacts")(function* (
  files: PlainFileStoreShape,
  stateDir: string,
  storyIds: ReadonlyArray<string>,
  commands: ReadonlyArray<ReadonlyArray<string>>
): Effect.fn.Return<{ readonly baselines: number; readonly logs: number }, FlowError> {
  const path = baselinesPath(stateDir)
  const hadBaselines = (yield* files.read(path)) !== undefined
  if (hadBaselines) {
    yield* files.remove(path)
  }
  let logs = 0
  for (const storyId of storyIds) {
    for (const [index, command] of commands.entries()) {
      const logPath = join(storyGateLogDir(stateDir, storyId), gateLogName(index, command))
      const text = yield* files.read(logPath)
      if (text === undefined) {
        continue
      }
      yield* files.writeAtomic(logPath, compactGateLog(text, []))
      logs += 1
    }
  }
  return { baselines: hadBaselines ? 1 : 0, logs }
})
