import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { LiveHolder } from "@llm4ts/flow/WriterLock"

/**
 * What the activities need from the machine (ADR 0060). The Node host is
 * `NodeFlowHost`; tests pass a fake, so no test needs a process, a clock or
 * a Temporal server.
 */

export interface FlowChildRequest {
  /** Arguments of `llm4ts`, the command itself excluded. */
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
}

export interface FlowChildExit {
  readonly code?: number
  readonly signal?: string
}

export interface FlowChild {
  /** The child leads its own process group, so this is the group's id too. */
  readonly pid: number
  /** Never fails; succeeds once the process is gone. */
  readonly exited: Effect.Effect<FlowChildExit>
}

export interface FlowHost {
  /** The worker's environment: what a flow it starts inherits. */
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly files: PlainFileStoreShape
  /** Starts `llm4ts` in its own process group. */
  readonly start: (request: FlowChildRequest) => Effect.Effect<FlowChild, LaunchError>
  readonly isAlive: (pid: number) => boolean
  /** Asks a run to stop the way Ctrl-C does: the interrupt goes to the group `pid` leads. */
  readonly interrupt: (pid: number) => Effect.Effect<void>
  /** Ends the process group `pid` leads, at once. */
  readonly killGroup: (pid: number) => Effect.Effect<void>
  /** The live holder of the checkout's writer lock (ADR 0058), if any. */
  readonly holder: (repo: string) => Effect.Effect<LiveHolder | undefined, PersistenceError>
  /** The directory of the checkout's control logs (ADR 0057). */
  readonly controlRoot: (repo: string) => string
}

export class LaunchError extends Schema.TaggedError<LaunchError>()("LaunchError", {
  message: Schema.String
}) {}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(TraceLine))
const RunEndedFields = Schema.Struct({
  outcome: Schema.String,
  error: Schema.optionalKey(Schema.String)
})
const decodeEnded = Schema.decodeUnknownOption(RunEndedFields)

/**
 * How a run ended, from the `RunEnded` line of its trace; `undefined` when
 * the trace is absent or the run never wrote that line. A line that does not
 * decode (a torn write) is skipped.
 */
export const readRunEnd = (
  files: PlainFileStoreShape,
  tracePath: string
): Effect.Effect<
  { readonly outcome: string; readonly error?: string } | undefined,
  PersistenceError
> =>
  files.read(tracePath).pipe(
    Effect.map((text) => {
      const rows = (text ?? "").split("\n")
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]
        if (row === undefined || row.trim().length === 0) continue
        const line = Option.getOrUndefined(decodeLine(row))
        if (line === undefined || line.kind !== "RunEnded") continue
        return Option.getOrUndefined(decodeEnded(line.fields))
      }
      return undefined
    })
  )
