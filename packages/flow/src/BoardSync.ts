import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { quoteWiql, type AzureDevOpsToolShape } from "./AzureDevOpsTool.ts"
import { FlowAborted, type FlowError } from "./FlowError.ts"
import { loadVersioned, saveVersioned, type PlainFileStoreShape } from "./Persistence.ts"

// The progress board of the conversion scenario: a port with the work-item
// lifecycle (plan → start → complete/fail/skip) and two adapters — a local
// file board (the default, fully offline: board.json + rendered board.md)
// and an Azure DevOps adapter (the stretch goal) mapping the same lifecycle
// onto work items. Flows depend only on the port; which board the client
// sees is wiring, not policy.

export const BoardVersion = 1

export const BoardStatus = Schema.Literals(["planned", "active", "done", "failed", "skipped"])
export type BoardStatus = typeof BoardStatus.Type

export class BoardItem extends Schema.Class<BoardItem>("BoardItem")({
  id: Schema.String,
  title: Schema.String,
  wave: Schema.optionalKey(Schema.String),
  status: BoardStatus,
  branch: Schema.optionalKey(Schema.String),
  reportPath: Schema.optionalKey(Schema.String),
  /** Free-form note: a failure reason, a skip rationale, a triage disposition. */
  detail: Schema.optionalKey(Schema.String),
  /** ESTIMATES, never measurements — see EstimatedUsage (ADR 0012). */
  estimatedTokens: Schema.optionalKey(Schema.Int),
  estimatedCostUsd: Schema.optionalKey(Schema.Number)
}) {}

export class Board extends Schema.Class<Board>("Board")({
  title: Schema.String,
  items: Schema.Array(BoardItem)
}) {}

export interface BoardItemResult {
  readonly branch?: string
  readonly reportPath?: string
  readonly detail?: string
  readonly estimatedTokens?: number
  readonly estimatedCostUsd?: number
}

export interface BoardSyncShape {
  /** Publish the full planned work list. Idempotent: known ids keep their state. */
  readonly plan: (items: ReadonlyArray<BoardItem>) => Effect.Effect<void, FlowError>
  readonly start: (id: string) => Effect.Effect<void, FlowError>
  readonly complete: (id: string, result: BoardItemResult) => Effect.Effect<void, FlowError>
  readonly fail: (id: string, reason: string) => Effect.Effect<void, FlowError>
  readonly skip: (id: string, reason: string) => Effect.Effect<void, FlowError>
  readonly snapshot: Effect.Effect<Board, FlowError>
}

const sectionOrder: ReadonlyArray<readonly [BoardStatus, string]> = [
  ["active", "Active"],
  ["planned", "Planned"],
  ["done", "Done"],
  ["failed", "Failed"],
  ["skipped", "Skipped"]
]

const itemLine = (item: BoardItem): string => {
  const parts: Array<string> = [`- **${item.id}** — ${item.title}`]
  if (item.wave !== undefined) {
    parts.push(`(wave: ${item.wave})`)
  }
  if (item.branch !== undefined) {
    parts.push(`branch \`${item.branch}\``)
  }
  if (item.reportPath !== undefined) {
    parts.push(`[report](${item.reportPath})`)
  }
  if (item.estimatedTokens !== undefined || item.estimatedCostUsd !== undefined) {
    const tokens = item.estimatedTokens === undefined ? "" : `~${item.estimatedTokens} tokens`
    const cost = item.estimatedCostUsd === undefined ? "" : `~$${item.estimatedCostUsd.toFixed(2)}`
    parts.push(`(${[tokens, cost].filter((part) => part.length > 0).join(", ")} — estimated)`)
  }
  if (item.detail !== undefined) {
    parts.push(`— ${item.detail}`)
  }
  return parts.join(" ")
}

/** The markdown board — every figure on it labelled estimated. */
export const renderBoard = (board: Board): string => {
  const lines: Array<string> = [`# Board: ${board.title}`, ""]
  const counts = sectionOrder
    .map(([status]) => `${status}: ${board.items.filter((item) => item.status === status).length}`)
    .join(" · ")
  lines.push(counts, "")
  lines.push(
    "All token and cost figures are ESTIMATES (character-count heuristics), not",
    "measurements.",
    ""
  )
  for (const [status, heading] of sectionOrder) {
    const items = board.items.filter((item) => item.status === status)
    if (items.length === 0) {
      continue
    }
    lines.push(`## ${heading}`, "")
    for (const item of items) {
      lines.push(itemLine(item))
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd() + "\n"
}

const join = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`

const applyResult = (item: BoardItem, status: BoardStatus, result: BoardItemResult): BoardItem =>
  BoardItem.make({
    ...item,
    status,
    ...(result.branch === undefined ? {} : { branch: result.branch }),
    ...(result.reportPath === undefined ? {} : { reportPath: result.reportPath }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ...(result.estimatedTokens === undefined
      ? {}
      : { estimatedTokens: Math.round(result.estimatedTokens) }),
    ...(result.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: result.estimatedCostUsd })
  })

/**
 * The default adapter: `board.json` (versioned) plus a rendered `board.md`
 * under `directory`. The JSON is the state, the markdown is the demo surface;
 * both are rewritten on every mutation so a crash never leaves them apart.
 */
export const makeLocalBoardSync = (
  files: PlainFileStoreShape,
  directory: string,
  title: string
): BoardSyncShape => {
  const jsonPath = join(directory, "board.json")
  const markdownPath = join(directory, "board.md")

  const load: Effect.Effect<Board, FlowError> = loadVersioned(
    files,
    jsonPath,
    BoardVersion,
    Board
  ).pipe(Effect.map((board) => board ?? Board.make({ title, items: [] })))

  const save = (board: Board): Effect.Effect<void, FlowError> =>
    saveVersioned(files, jsonPath, BoardVersion, Board, board).pipe(
      Effect.andThen(files.writeAtomic(markdownPath, renderBoard(board)))
    )

  const update = (
    id: string,
    transform: (item: BoardItem) => BoardItem
  ): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      const board = yield* load
      if (!board.items.some((item) => item.id === id)) {
        return yield* FlowAborted.make({ message: `board has no item '${id}' — plan it first` })
      }
      yield* save(
        Board.make({
          ...board,
          items: board.items.map((item) => (item.id === id ? transform(item) : item))
        })
      )
    })

  return {
    plan: (items) =>
      Effect.gen(function* () {
        const board = yield* load
        const known = new Map(board.items.map((item) => [item.id, item] as const))
        // Known ids keep their lived state — re-planning must never demote a
        // converted page back to "planned".
        const merged = [...board.items, ...items.filter((item) => !known.has(item.id))]
        yield* save(Board.make({ title: board.title, items: merged }))
      }),
    start: (id) => update(id, (item) => BoardItem.make({ ...item, status: "active" })),
    complete: (id, result) => update(id, (item) => applyResult(item, "done", result)),
    fail: (id, reason) =>
      update(id, (item) => BoardItem.make({ ...item, status: "failed", detail: reason })),
    skip: (id, reason) =>
      update(id, (item) => BoardItem.make({ ...item, status: "skipped", detail: reason })),
    snapshot: load
  }
}

/**
 * Fan one lifecycle out to several boards (local file + ADO, typically).
 * Mutations hit every board in order; `snapshot` reads the FIRST — the local
 * board is the source of truth, the others are mirrors.
 */
export const composeBoardSync = (boards: ReadonlyArray<BoardSyncShape>): BoardSyncShape => {
  const first = boards[0]
  const each = (
    operation: (board: BoardSyncShape) => Effect.Effect<void, FlowError>
  ): Effect.Effect<void, FlowError> => Effect.forEach(boards, operation, { discard: true })
  return {
    plan: (items) => each((board) => board.plan(items)),
    start: (id) => each((board) => board.start(id)),
    complete: (id, result) => each((board) => board.complete(id, result)),
    fail: (id, reason) => each((board) => board.fail(id, reason)),
    skip: (id, reason) => each((board) => board.skip(id, reason)),
    snapshot:
      first === undefined
        ? Effect.succeed(Board.make({ title: "empty", items: [] }))
        : first.snapshot
  }
}

export interface AdoBoardOptions {
  /** Work item type created for each page. Default "Task". */
  readonly workItemType?: string
  /** Tag identifying this board's items — the idempotency key. Default "llm4ts-convert". */
  readonly tag?: string
  /** Lifecycle → System.State mapping. Defaults: New / Active / Closed. */
  readonly states?: {
    readonly planned?: string
    readonly active?: string
    readonly done?: string
  }
}

const markerQuery = (tag: string, id: string): string =>
  "SELECT [System.Id] FROM WorkItems WHERE " +
  `[System.Tags] CONTAINS ${quoteWiql(tag)} AND ` +
  `[System.Title] CONTAINS ${quoteWiql(`[${id}]`)}`

/**
 * The stretch adapter (ADR 0012): the same lifecycle mapped onto Azure DevOps
 * work items through the az-CLI AzureDevOpsTool (ADR 0011). Idempotent by
 * title marker — `[<id>]` plus the board tag — so a re-run finds its items
 * instead of duplicating them. Failure and skip are tags plus a comment,
 * never invented states.
 */
export const makeAdoBoardSync = Effect.fn("@llm4ts/flow/BoardSync.makeAdo")(function* (
  ado: AzureDevOpsToolShape,
  boardTitle: string,
  options: AdoBoardOptions = {}
): Effect.fn.Return<BoardSyncShape> {
  const workItemType = options.workItemType ?? "Task"
  const tag = options.tag ?? "llm4ts-convert"
  const states = {
    planned: options.states?.planned ?? "New",
    active: options.states?.active ?? "Active",
    done: options.states?.done ?? "Closed"
  }
  const ids = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

  const lookup = (id: string): Effect.Effect<number, FlowError> =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(ids)).get(id)
      if (cached !== undefined) {
        return cached
      }
      const found = yield* ado.wiqlIds(markerQuery(tag, id))
      const first = found[0]
      if (first === undefined) {
        return yield* FlowAborted.make({
          message: `no ADO work item tagged '${tag}' with '[${id}]' in its title — plan it first`
        })
      }
      yield* Ref.update(ids, (current) => new Map(current).set(id, first))
      return first
    })

  return {
    plan: (items) =>
      Effect.gen(function* () {
        for (const item of items) {
          const existing = yield* ado.wiqlIds(markerQuery(tag, item.id))
          const first = existing[0]
          if (first !== undefined) {
            yield* Ref.update(ids, (current) => new Map(current).set(item.id, first))
            continue
          }
          const created = yield* ado.createWorkItem(
            workItemType,
            `[${item.id}] ${item.title}`,
            item.detail ?? item.title,
            [tag]
          )
          yield* Ref.update(ids, (current) => new Map(current).set(item.id, created.id))
          if (states.planned !== "New") {
            yield* ado.setState(created.id, states.planned)
          }
        }
      }),
    start: (id) =>
      Effect.gen(function* () {
        const workItem = yield* lookup(id)
        yield* ado.setState(workItem, states.active)
      }),
    complete: (id, result) =>
      Effect.gen(function* () {
        const workItem = yield* lookup(id)
        const parts = [
          result.branch === undefined ? undefined : `Branch: ${result.branch}`,
          result.reportPath === undefined ? undefined : `Report: ${result.reportPath}`,
          result.estimatedTokens === undefined
            ? undefined
            : `~${Math.round(result.estimatedTokens)} tokens (estimated)`,
          result.estimatedCostUsd === undefined
            ? undefined
            : `~$${result.estimatedCostUsd.toFixed(2)} (estimated)`,
          result.detail
        ].filter((part): part is string => part !== undefined)
        if (parts.length > 0) {
          yield* ado.writeComment(workItem, parts.join("\n"))
        }
        yield* ado.setState(workItem, states.done)
      }),
    fail: (id, reason) =>
      Effect.gen(function* () {
        const workItem = yield* lookup(id)
        yield* ado.editTags(workItem, [`${tag}-failed`], [])
        yield* ado.writeComment(workItem, `FAILED: ${reason}`)
      }),
    skip: (id, reason) =>
      Effect.gen(function* () {
        const workItem = yield* lookup(id)
        yield* ado.editTags(workItem, [`${tag}-skipped`], [])
        yield* ado.writeComment(workItem, `SKIPPED: ${reason}`)
      }),
    snapshot: Effect.gen(function* () {
      const found = yield* ado.wiqlIds(
        `SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS ${quoteWiql(tag)}`
      )
      const items: Array<BoardItem> = []
      for (const workItemId of found) {
        const workItem = yield* ado.readWorkItem(workItemId)
        const match = /^\[([^\]]+)\] (.*)$/.exec(workItem.title)
        const failed = workItem.tags.includes(`${tag}-failed`)
        const skipped = workItem.tags.includes(`${tag}-skipped`)
        const status: BoardStatus = failed
          ? "failed"
          : skipped
            ? "skipped"
            : workItem.state === states.done
              ? "done"
              : workItem.state === states.active
                ? "active"
                : "planned"
        items.push(
          BoardItem.make({
            id: match?.[1] ?? String(workItemId),
            title: match?.[2] ?? workItem.title,
            status
          })
        )
      }
      return Board.make({ title: boardTitle, items })
    })
  }
})
