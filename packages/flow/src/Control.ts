import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "./FlowError.ts"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "./Persistence.ts"
import { dependentsOf, type StoryPlan } from "./StoryPlan.ts"

/**
 * The control inbox of a running epic (ADR 0057): what a person tells a live
 * run. Commands are lines in an append-only log outside the checkout; the
 * story scheduler polls it, applies each command once and answers with a
 * receipt line. A command with no receipt is pending.
 */

/** A story that failed in this run becomes ready again. */
export class RetryStory extends Schema.TaggedClass<RetryStory>()("RetryStory", {
  story: Schema.String
}) {}

/** A story is not launched, or is interrupted; its dependents wait. */
export class SkipStory extends Schema.TaggedClass<SkipStory>()("SkipStory", {
  story: Schema.String,
  reason: Schema.String
}) {}

export const ControlAction = Schema.Union([RetryStory, SkipStory])
export type ControlAction = typeof ControlAction.Type

export const ControlLogVersion = 1

export class ControlCommand extends Schema.TaggedClass<ControlCommand>()("ControlCommand", {
  schemaVersion: Schema.Literal(ControlLogVersion),
  id: Schema.String,
  /** Epoch milliseconds. */
  at: Schema.Number,
  /** Where it came from (`cli`, `mcp`, `chat:<user id>`): recorded, not authenticated. */
  by: Schema.String,
  command: ControlAction
}) {}

export const ControlOutcome = Schema.Literals(["applied", "refused", "expired"])
export type ControlOutcome = typeof ControlOutcome.Type

export class ControlReceipt extends Schema.TaggedClass<ControlReceipt>()("ControlReceipt", {
  schemaVersion: Schema.Literal(ControlLogVersion),
  id: Schema.String,
  runId: Schema.String,
  at: Schema.Number,
  outcome: ControlOutcome,
  /** Why it was refused. */
  reason: Schema.optionalKey(Schema.String)
}) {}

const ControlLine = Schema.Union([ControlCommand, ControlReceipt])
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(ControlLine))
const encodeLine = Schema.encodeSync(Schema.fromJsonString(ControlLine))

export interface ControlLog {
  /** Every command, oldest first, once per id. */
  readonly commands: ReadonlyArray<ControlCommand>
  /** The receipt of each answered command, by command id. */
  readonly receipts: ReadonlyMap<string, ControlReceipt>
}

/** A log's commands and receipts; a line that does not decode (a torn write) is skipped. */
export const readControlLog = (text: string | undefined): ControlLog => {
  const commands = new Map<string, ControlCommand>()
  const receipts = new Map<string, ControlReceipt>()
  for (const row of (text ?? "").split("\n")) {
    if (row.trim().length === 0) continue
    for (const line of Option.toArray(decodeLine(row))) {
      if (line._tag === "ControlCommand") {
        if (!commands.has(line.id)) commands.set(line.id, line)
      } else {
        receipts.set(line.id, line)
      }
    }
  }
  return { commands: [...commands.values()], receipts }
}

export interface ControlSubmission {
  /** Supplied by the writer or generated; a second command with a known id is not written. */
  readonly id?: string
  readonly by: string
  readonly command: ControlAction
}

export interface ControlInboxShape {
  /** Commands without a receipt, oldest first. */
  readonly pending: (epic: string) => Effect.Effect<ReadonlyArray<ControlCommand>, PersistenceError>
  readonly receipt: (
    epic: string,
    receipt: {
      readonly id: string
      readonly runId: string
      readonly outcome: ControlOutcome
      readonly reason?: string
    }
  ) => Effect.Effect<void, PersistenceError>
  /** Writes a command; returns the one already in the log when its id is known. */
  readonly submit: (
    epic: string,
    submission: ControlSubmission
  ) => Effect.Effect<ControlCommand, PersistenceError>
  readonly log: (epic: string) => Effect.Effect<ControlLog, PersistenceError>
}

export interface ControlInboxOptions {
  readonly files: PlainFileStoreShape
  /** The directory of one checkout's logs; the runner and the shell name it. */
  readonly root: string
  /** A new command id; injectable so tests are deterministic. */
  readonly newId?: () => string
}

const randomId = (): string =>
  `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 0x100000000).toString(16)}`

/** An epic's log file under a checkout's control directory. */
export const controlLogPath = (root: string, epic: string): string => join(root, `${epic}.jsonl`)

export const makeControlInbox = (options: ControlInboxOptions): ControlInboxShape => {
  const newId = options.newId ?? randomId
  const log = (epic: string) =>
    options.files.read(controlLogPath(options.root, epic)).pipe(Effect.map(readControlLog))
  const append = (epic: string, line: ControlCommand | ControlReceipt) =>
    options.files.append(controlLogPath(options.root, epic), `${encodeLine(line)}\n`)
  return {
    log,
    pending: (epic) =>
      log(epic).pipe(
        Effect.map(({ commands, receipts }) =>
          commands.filter((command) => !receipts.has(command.id))
        )
      ),
    receipt: (epic, receipt) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* append(
          epic,
          ControlReceipt.make({
            schemaVersion: ControlLogVersion,
            id: receipt.id,
            runId: receipt.runId,
            at,
            outcome: receipt.outcome,
            ...(receipt.reason === undefined ? {} : { reason: receipt.reason })
          })
        )
      }),
    submit: (epic, submission) =>
      Effect.gen(function* () {
        const id = submission.id ?? newId()
        const known = (yield* log(epic)).commands.find((command) => command.id === id)
        if (known !== undefined) return known
        const command = ControlCommand.make({
          schemaVersion: ControlLogVersion,
          id,
          at: yield* Clock.currentTimeMillis,
          by: submission.by,
          command: submission.command
        })
        yield* append(epic, command)
        return command
      })
  }
}

export interface MemoryControlInbox {
  readonly inbox: ControlInboxShape
  readonly files: Effect.Effect<Readonly<Record<string, string>>>
}

/** The in-memory inbox for tests; command ids count up from `c-1`. */
export const makeMemoryControlInbox = (root = "/control"): Effect.Effect<MemoryControlInbox> =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    let next = 0
    return {
      inbox: makeControlInbox({ files: memory.store, root, newId: () => `c-${++next}` }),
      files: memory.files
    }
  })

/** Where every story of the plan stands in the scheduler when a command arrives. */
export interface ControlState {
  readonly done: ReadonlySet<string>
  readonly failed: ReadonlySet<string>
  readonly skipped: ReadonlySet<string>
  /** Stories on hold, with what each waits for. */
  readonly waiting: ReadonlyMap<string, string>
  readonly running: ReadonlySet<string>
  /** Why the run launches no further story, when it does not. */
  readonly halted?: string
}

export type ControlDecision =
  | {
      readonly _tag: "Retry"
      readonly story: string
      /** Dependents held behind the story, released with it. */
      readonly release: ReadonlyArray<string>
    }
  | {
      readonly _tag: "Skip"
      readonly story: string
      readonly reason: string
      /** The story is running and must be interrupted. */
      readonly interrupt: boolean
    }
  | { readonly _tag: "Refused"; readonly reason: string }

const refused = (reason: string): ControlDecision => ({ _tag: "Refused", reason })

/** What the scheduler said when it put a story on hold behind another. */
export const waitingFor = (story: string): string => `waiting for ${story}`

/** What a command does to a run: pure, so it is tested without a clock or a file. */
export const decideControl = (
  plan: StoryPlan,
  state: ControlState,
  command: ControlAction
): ControlDecision => {
  const id = command.story
  if (plan.story(id) === undefined) {
    return refused(`'${id}' is not a story of epic ${plan.epicId}`)
  }
  if (state.done.has(id)) {
    return refused(`story ${id} is done`)
  }
  if (command._tag === "SkipStory") {
    return state.skipped.has(id)
      ? refused(`story ${id} is already skipped`)
      : { _tag: "Skip", story: id, reason: command.reason, interrupt: state.running.has(id) }
  }
  if (state.running.has(id)) {
    return refused(`story ${id} is running`)
  }
  if (!state.failed.has(id)) {
    return refused(`story ${id} did not fail in this run`)
  }
  if (state.halted !== undefined) {
    return refused(`the run launches no further story: ${state.halted}`)
  }
  const dependents = new Set(dependentsOf(plan, id))
  return {
    _tag: "Retry",
    story: id,
    release: [...state.waiting]
      .filter(([waiter, reason]) => dependents.has(waiter) && reason === waitingFor(id))
      .map(([waiter]) => waiter)
  }
}
