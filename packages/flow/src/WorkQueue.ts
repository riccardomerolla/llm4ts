// A mechanical work queue (ADR 0028): many small units with a filesystem
// "done" predicate, worked in rounds under a concurrency cap, each unit's
// failure becoming the next round's item, progress persisted as a ledger so
// a rerun resumes where the run stopped. The Bun port's shape; a story is a
// feature with a DAG and a judge, a queue item is a file with a predicate.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Stalled, describeFlowError, type FlowError } from "./FlowError.ts"
import {
  Info,
  StageCompleted,
  StageFailed,
  StageStarted,
  type FlowEventsShape
} from "./FlowEvents.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export interface QueueItem {
  readonly id: string
}

export const Confidence = Schema.Literals(["high", "medium", "low"])

/** One line of the ledger: what happened to one item in one round. */
export class QueueOutcome extends Schema.Class<QueueOutcome>("QueueOutcome")({
  id: Schema.String,
  round: Schema.Int,
  status: Schema.Literals(["done", "failed"]),
  ms: Schema.Number,
  note: Schema.optionalKey(Schema.String),
  confidence: Schema.optionalKey(Confidence),
  todos: Schema.optionalKey(Schema.Int),
  at: Schema.Number
}) {}

const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(QueueOutcome))
const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(QueueOutcome))

/** What a unit of work reports back; the queue records it. */
export interface WorkResult {
  readonly note?: string
  readonly confidence?: "high" | "medium" | "low"
  readonly todos?: number
}

export interface RunQueueOptions<Item extends QueueItem> {
  readonly label: string
  readonly items: ReadonlyArray<Item>
  /** The filesystem predicate: an item whose output exists is done, whatever the ledger says. */
  readonly done: (item: Item) => Effect.Effect<boolean, FlowError>
  /** One unit of work: implement, review, fix; the queue catches its failure. */
  readonly work: (item: Item, round: number) => Effect.Effect<WorkResult, FlowError>
  readonly events: FlowEventsShape
  readonly concurrency?: number
  /** Rounds over the items that failed; default 3. */
  readonly maxRounds?: number
  /** Where outcomes are appended, one JSON line each; omit to keep none. */
  readonly ledger?: { readonly files: PlainFileStoreShape; readonly path: string }
  /** After every round: the done items of that round, for a commit. */
  readonly afterRound?: (
    round: number,
    done: ReadonlyArray<Item>,
    failed: ReadonlyArray<Item>
  ) => Effect.Effect<void, FlowError>
}

export interface QueueReport<Item extends QueueItem> {
  readonly outcomes: ReadonlyArray<QueueOutcome>
  readonly rounds: number
  /** Items still not done when the queue stopped. */
  readonly pending: ReadonlyArray<Item>
  /** Items that were already done before the first round (a resume). */
  readonly skipped: ReadonlyArray<Item>
}

export const readLedger = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<ReadonlyArray<QueueOutcome>, FlowError> =>
  Effect.map(files.read(path), (text) =>
    (text ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        const decoded = decodeOutcome(line)
        return decoded._tag === "Some" ? [decoded.value] : []
      })
  )

/**
 * Works the items that are not done, round after round, until every item is
 * done, the rounds run out, or a round makes no progress (typed `Stalled`).
 */
export const runQueue = Effect.fn("@llm4ts/flow/WorkQueue.run")(function* <Item extends QueueItem>(
  options: RunQueueOptions<Item>
): Effect.fn.Return<QueueReport<Item>, FlowError> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  const outcomes: Array<QueueOutcome> = []
  const record = (outcome: QueueOutcome): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      outcomes.push(outcome)
      if (options.ledger !== undefined) {
        yield* options.ledger.files.append(options.ledger.path, `${encodeOutcome(outcome)}\n`)
      }
    })

  const skipped: Array<Item> = []
  let pending: Array<Item> = []
  for (const item of options.items) {
    if (yield* options.done(item)) {
      skipped.push(item)
    } else {
      pending.push(item)
    }
  }
  if (skipped.length > 0) {
    yield* options.events.publish(
      Info.make({
        message: `${options.label}: ${skipped.length} of ${options.items.length} item(s) already done; ${pending.length} to go`
      })
    )
  }

  let rounds = 0
  while (pending.length > 0 && rounds < maxRounds) {
    rounds += 1
    const round = rounds
    yield* options.events.publish(
      Info.make({ message: `${options.label}: round ${round}, ${pending.length} item(s)` })
    )
    const results = yield* Effect.forEach(
      pending,
      (item) =>
        Effect.gen(function* () {
          const stage = `${options.label} ${item.id}`
          yield* options.events.publish(StageStarted.make({ stage, lane: item.id }))
          const started = yield* Clock.currentTimeMillis
          const result = yield* options.work(item, round).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error: FlowError) =>
              Effect.succeed({ ok: false as const, error: describeFlowError(error) })
            )
          )
          const ended = yield* Clock.currentTimeMillis
          // The predicate decides, not the work's own account of itself.
          const finished = result.ok && (yield* options.done(item))
          const outcome = QueueOutcome.make({
            id: item.id,
            round,
            status: finished ? "done" : "failed",
            ms: ended - started,
            at: ended,
            ...(result.ok
              ? {
                  ...(finished
                    ? {}
                    : { note: result.value.note ?? "the work ended but left no output" }),
                  ...(finished && result.value.note !== undefined
                    ? { note: result.value.note }
                    : {}),
                  ...(result.value.confidence === undefined
                    ? {}
                    : { confidence: result.value.confidence }),
                  ...(result.value.todos === undefined ? {} : { todos: result.value.todos })
                }
              : { note: result.error })
          })
          yield* record(outcome)
          yield* options.events.publish(
            finished
              ? StageCompleted.make({ stage, lane: item.id })
              : StageFailed.make({ stage, lane: item.id, message: outcome.note ?? "failed" })
          )
          return { item, finished }
        }),
      { concurrency }
    )
    const done = results.filter((entry) => entry.finished).map((entry) => entry.item)
    const failed = results.filter((entry) => !entry.finished).map((entry) => entry.item)
    if (options.afterRound !== undefined) {
      yield* options.afterRound(round, done, failed)
    }
    if (done.length === 0 && failed.length > 0) {
      return yield* Stalled.make({
        signal: "no-progress",
        detail: `${options.label}: round ${round} finished none of its ${failed.length} item(s)`
      })
    }
    pending = failed
  }
  return { outcomes, rounds, pending, skipped }
})
