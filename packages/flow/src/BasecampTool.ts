import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { ColumnNotFound, ProcessError, type FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { guarded } from "./CapabilityGuard.ts"

// One tool instance operates one board. `cardTable` is only needed when the
// project has more than one card table (the CLI resolves the single one).
export class BasecampProjectRef extends Schema.Class<BasecampProjectRef>("BasecampProjectRef")({
  project: Schema.String,
  cardTable: Schema.optionalKey(Schema.String)
}) {}

export class Column extends Schema.Class<Column>("Column")({
  id: Schema.Int,
  title: Schema.String
}) {}

// Basecamp bodies are rich-text HTML, never Markdown — the field names say so.
export class Card extends Schema.Class<Card>("Card")({
  id: Schema.Int,
  title: Schema.String,
  contentHtml: Schema.String,
  column: Column,
  assignees: Schema.Array(Schema.String),
  commentsCount: Schema.Int,
  updatedAt: Schema.String,
  url: Schema.String
}) {}

export class CardComment extends Schema.Class<CardComment>("CardComment")({
  id: Schema.Int,
  author: Schema.String,
  contentHtml: Schema.String,
  createdAt: Schema.String
}) {}

export class CardStep extends Schema.Class<CardStep>("CardStep")({
  id: Schema.Int,
  title: Schema.String,
  completed: Schema.Boolean
}) {}

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.Int,
  title: Schema.String,
  contentHtml: Schema.String,
  createdAt: Schema.String
}) {}

export class Todolist extends Schema.Class<Todolist>("Todolist")({
  id: Schema.Int,
  title: Schema.String
}) {}

export class TodoItem extends Schema.Class<TodoItem>("TodoItem")({
  id: Schema.Int,
  title: Schema.String,
  completed: Schema.Boolean
}) {}

const projectFlags = (board: BasecampProjectRef): ReadonlyArray<string> => [
  "--project",
  board.project,
  ...(board.cardTable === undefined ? [] : ["--card-table", board.cardTable])
]

const jsonFlags = ["--json", "--quiet"]

export const cardColumnsArgs = (board: BasecampProjectRef): ReadonlyArray<string> => [
  "cards",
  "columns",
  ...projectFlags(board),
  ...jsonFlags
]

export const cardListArgs = (board: BasecampProjectRef, column: Column): ReadonlyArray<string> => [
  "cards",
  "list",
  "--column",
  String(column.id),
  "--all",
  ...projectFlags(board),
  ...jsonFlags
]

export const cardShowArgs = (board: BasecampProjectRef, cardId: number): ReadonlyArray<string> => [
  "cards",
  "show",
  String(cardId),
  ...projectFlags(board),
  ...jsonFlags
]

export const cardMoveArgs = (
  board: BasecampProjectRef,
  cardId: number,
  column: Column
): ReadonlyArray<string> => [
  "cards",
  "move",
  String(cardId),
  "--to",
  String(column.id),
  ...projectFlags(board),
  "--quiet"
]

export const cardCreateArgs = (
  board: BasecampProjectRef,
  column: Column,
  title: string,
  content: string,
  assignee?: string
): ReadonlyArray<string> => [
  "cards",
  "create",
  title,
  content,
  "--column",
  String(column.id),
  ...(assignee === undefined ? [] : ["--assignee", assignee]),
  ...projectFlags(board),
  ...jsonFlags
]

export const cardAssignArgs = (
  board: BasecampProjectRef,
  cardId: number,
  assignee: string
): ReadonlyArray<string> => [
  "cards",
  "update",
  String(cardId),
  "--assignee",
  assignee,
  ...projectFlags(board),
  "--quiet"
]

// Comments hang off the card alone; `basecamp comments` rejects --project.
export const cardCommentsArgs = (cardId: number): ReadonlyArray<string> => [
  "comments",
  "list",
  String(cardId),
  "--all",
  ...jsonFlags
]

export const cardCommentCreateArgs = (cardId: number, body: string): ReadonlyArray<string> => [
  "comments",
  "create",
  String(cardId),
  body,
  ...jsonFlags
]

export const cardCommentUpdateArgs = (commentId: number, body: string): ReadonlyArray<string> => [
  "comments",
  "update",
  String(commentId),
  body,
  "--quiet"
]

export const cardStepsArgs = (board: BasecampProjectRef, cardId: number): ReadonlyArray<string> => [
  "cards",
  "steps",
  String(cardId),
  ...projectFlags(board),
  ...jsonFlags
]

export const cardStepCompleteArgs = (
  board: BasecampProjectRef,
  stepId: number
): ReadonlyArray<string> => [
  "cards",
  "step",
  "complete",
  String(stepId),
  ...projectFlags(board),
  "--quiet"
]

// Messages and todolists commands take --project only: --card-table
// belongs to the cards subcommands and is rejected elsewhere.
const projectOnlyFlags = (board: BasecampProjectRef): ReadonlyArray<string> => [
  "--project",
  board.project
]

export const messageListArgs = (board: BasecampProjectRef): ReadonlyArray<string> => [
  "messages",
  "list",
  ...projectOnlyFlags(board),
  ...jsonFlags
]

// --no-subscribe: agent-written memory must not notify humans per post.
export const messageCreateArgs = (
  board: BasecampProjectRef,
  title: string,
  body: string
): ReadonlyArray<string> => [
  "messages",
  "create",
  title,
  body,
  "--no-subscribe",
  ...projectOnlyFlags(board),
  ...jsonFlags
]

export const todolistListArgs = (board: BasecampProjectRef): ReadonlyArray<string> => [
  "todolists",
  "list",
  ...projectOnlyFlags(board),
  ...jsonFlags
]

export const todoListArgs = (
  board: BasecampProjectRef,
  todolistId: number
): ReadonlyArray<string> => [
  "todos",
  "list",
  "--list",
  String(todolistId),
  ...projectOnlyFlags(board),
  ...jsonFlags
]

const decodeJson = <A, S extends Schema.Codec<A, string>>(
  operation: string,
  schema: S,
  json: string
): Effect.Effect<S["Type"], ProcessError> =>
  Schema.decodeUnknownEffect(schema)(json).pipe(
    Effect.mapError((error) =>
      ProcessError.make({
        message: operation,
        detail: String(error)
      })
    )
  )

const columnStruct = Schema.Struct({
  id: Schema.Int,
  title: Schema.String
})

// The CLI prints `null` (not `[]`) for every empty listing — columns,
// cards in a column, comments — so all list decoders tolerate it.
export const parseColumns = (json: string): Effect.Effect<ReadonlyArray<Column>, ProcessError> =>
  decodeJson(
    "basecamp parse columns",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(columnStruct))),
    json
  ).pipe(Effect.map((columns) => (columns ?? []).map((column) => Column.make(column))))

const cardStruct = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent: columnStruct,
  assignees: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String })))
  ),
  comments_count: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  updated_at: Schema.String,
  app_url: Schema.String
})

const toCard = (item: typeof cardStruct.Type): Card =>
  Card.make({
    id: item.id,
    title: item.title,
    contentHtml: item.content ?? "",
    column: Column.make(item.parent),
    assignees: (item.assignees ?? []).map((assignee) => assignee.name),
    commentsCount: item.comments_count ?? 0,
    updatedAt: item.updated_at,
    url: item.app_url
  })

export const parseCard = (json: string): Effect.Effect<Card, ProcessError> =>
  decodeJson("basecamp parse card", Schema.fromJsonString(cardStruct), json).pipe(
    Effect.map(toCard)
  )

export const parseCards = (json: string): Effect.Effect<ReadonlyArray<Card>, ProcessError> =>
  decodeJson(
    "basecamp parse cards",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(cardStruct))),
    json
  ).pipe(Effect.map((items) => (items ?? []).map(toCard)))

const commentStruct = Schema.Struct({
  id: Schema.Int,
  content: Schema.String,
  creator: Schema.Struct({ name: Schema.String }),
  created_at: Schema.String
})

const toCardComment = (item: typeof commentStruct.Type): CardComment =>
  CardComment.make({
    id: item.id,
    author: item.creator.name,
    contentHtml: item.content,
    createdAt: item.created_at
  })

export const parseCardComment = (json: string): Effect.Effect<CardComment, ProcessError> =>
  decodeJson("basecamp parse comment", Schema.fromJsonString(commentStruct), json).pipe(
    Effect.map(toCardComment)
  )

export const parseCardComments = (
  json: string
): Effect.Effect<ReadonlyArray<CardComment>, ProcessError> =>
  decodeJson(
    "basecamp parse comments",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(commentStruct))),
    json
  ).pipe(Effect.map((comments) => (comments ?? []).map(toCardComment)))

const stepStruct = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  completed: Schema.Boolean
})

// A card without steps prints `null`, not `[]`.
export const parseCardSteps = (
  json: string
): Effect.Effect<ReadonlyArray<CardStep>, ProcessError> =>
  decodeJson(
    "basecamp parse steps",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(stepStruct))),
    json
  ).pipe(Effect.map((steps) => (steps ?? []).map((step) => CardStep.make(step))))

const messageStruct = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String
})

const toMessage = (item: typeof messageStruct.Type): Message =>
  Message.make({
    id: item.id,
    title: item.title,
    contentHtml: item.content ?? "",
    createdAt: item.created_at
  })

export const parseMessage = (json: string): Effect.Effect<Message, ProcessError> =>
  decodeJson("basecamp parse message", Schema.fromJsonString(messageStruct), json).pipe(
    Effect.map(toMessage)
  )

export const parseMessages = (json: string): Effect.Effect<ReadonlyArray<Message>, ProcessError> =>
  decodeJson(
    "basecamp parse messages",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(messageStruct))),
    json
  ).pipe(Effect.map((items) => (items ?? []).map(toMessage)))

const todolistStruct = Schema.Struct({
  id: Schema.Int,
  title: Schema.String
})

export const parseTodolists = (
  json: string
): Effect.Effect<ReadonlyArray<Todolist>, ProcessError> =>
  decodeJson(
    "basecamp parse todolists",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(todolistStruct))),
    json
  ).pipe(Effect.map((items) => (items ?? []).map((item) => Todolist.make(item))))

const todoStruct = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  completed: Schema.Boolean
})

export const parseTodos = (json: string): Effect.Effect<ReadonlyArray<TodoItem>, ProcessError> =>
  decodeJson(
    "basecamp parse todos",
    Schema.fromJsonString(Schema.NullOr(Schema.Array(todoStruct))),
    json
  ).pipe(Effect.map((items) => (items ?? []).map((item) => TodoItem.make(item))))

export interface BasecampToolShape {
  readonly listColumns: Effect.Effect<ReadonlyArray<Column>, FlowError>
  readonly resolveColumn: (title: string) => Effect.Effect<Column, FlowError>
  readonly listCards: (column: Column) => Effect.Effect<ReadonlyArray<Card>, FlowError>
  readonly readCard: (cardId: number) => Effect.Effect<Card, FlowError>
  readonly moveCard: (cardId: number, column: Column) => Effect.Effect<void, FlowError>
  readonly createCard: (
    column: Column,
    title: string,
    content: string,
    assignee?: string
  ) => Effect.Effect<Card, FlowError>
  readonly assignCard: (cardId: number, assignee: string) => Effect.Effect<void, FlowError>
  readonly readCardComments: (
    cardId: number
  ) => Effect.Effect<ReadonlyArray<CardComment>, FlowError>
  readonly writeCardComment: (cardId: number, body: string) => Effect.Effect<CardComment, FlowError>
  readonly editCardComment: (commentId: number, body: string) => Effect.Effect<void, FlowError>
  readonly listSteps: (cardId: number) => Effect.Effect<ReadonlyArray<CardStep>, FlowError>
  readonly completeStep: (stepId: number) => Effect.Effect<void, FlowError>
  readonly listMessages: Effect.Effect<ReadonlyArray<Message>, FlowError>
  readonly createMessage: (title: string, body: string) => Effect.Effect<Message, FlowError>
  readonly listTodolists: Effect.Effect<ReadonlyArray<Todolist>, FlowError>
  readonly listTodos: (todolistId: number) => Effect.Effect<ReadonlyArray<TodoItem>, FlowError>
}

const output = (result: ProcessResult): string => result.stdout.join("\n").trim()

export const makeBasecampTool = Effect.fn("@llm4ts/flow/BasecampTool.make")(function* (
  process: ProcessExecutorShape,
  workDir: string,
  events: FlowEventsShape,
  board: BasecampProjectRef
): Effect.fn.Return<BasecampToolShape> {
  const columnsCache = yield* Ref.make<ReadonlyArray<Column> | undefined>(undefined)

  const run = (args: ReadonlyArray<string>): Effect.Effect<ProcessResult, FlowError> =>
    process.run(["basecamp", ...args], workDir, {}).pipe(
      Effect.mapError((error) =>
        ProcessError.make({
          message: `basecamp ${args.join(" ")}`,
          detail: error.message
        })
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(
              ProcessError.make({
                message: `basecamp ${args.join(" ")}`,
                detail:
                  [...result.stdout, ...result.stderr].join("\n").trim() ||
                  `exit code ${result.exitCode}`
              })
            )
      )
    )

  const read = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.BasecampRead, operation, events, effect)
  const write = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.BasecampWrite, operation, events, effect)

  // The board's columns barely change within a tool's lifetime; fetch once.
  const cachedColumns: Effect.Effect<ReadonlyArray<Column>, FlowError> = Ref.get(columnsCache).pipe(
    Effect.flatMap((cached) =>
      cached !== undefined
        ? Effect.succeed(cached)
        : run(cardColumnsArgs(board)).pipe(
            Effect.flatMap((result) => parseColumns(output(result))),
            Effect.tap((columns) => Ref.set(columnsCache, columns))
          )
    )
  )

  return {
    listColumns: read("basecamp cards columns", cachedColumns),
    resolveColumn: (title) =>
      read(
        "basecamp cards columns",
        cachedColumns.pipe(
          Effect.flatMap((columns) => {
            const match = columns.find(
              (column) => column.title.toLowerCase() === title.toLowerCase()
            )
            return match !== undefined
              ? Effect.succeed(match)
              : Effect.fail(
                  ColumnNotFound.make({
                    title,
                    available: columns.map((column) => column.title)
                  })
                )
          })
        )
      ),
    listCards: (column) =>
      read(
        "basecamp cards list",
        run(cardListArgs(board, column)).pipe(
          Effect.flatMap((result) => parseCards(output(result)))
        )
      ),
    readCard: (cardId) =>
      read(
        "basecamp cards show",
        run(cardShowArgs(board, cardId)).pipe(Effect.flatMap((result) => parseCard(output(result))))
      ),
    moveCard: (cardId, column) =>
      write("basecamp cards move", run(cardMoveArgs(board, cardId, column)).pipe(Effect.asVoid)),
    createCard: (column, title, content, assignee) =>
      write(
        "basecamp cards create",
        run(cardCreateArgs(board, column, title, content, assignee)).pipe(
          Effect.flatMap((result) => parseCard(output(result)))
        )
      ),
    assignCard: (cardId, assignee) =>
      write(
        "basecamp cards update",
        run(cardAssignArgs(board, cardId, assignee)).pipe(Effect.asVoid)
      ),
    readCardComments: (cardId) =>
      read(
        "basecamp comments list",
        run(cardCommentsArgs(cardId)).pipe(
          Effect.flatMap((result) => parseCardComments(output(result)))
        )
      ),
    writeCardComment: (cardId, body) =>
      write(
        "basecamp comments create",
        run(cardCommentCreateArgs(cardId, body)).pipe(
          Effect.flatMap((result) => parseCardComment(output(result)))
        )
      ),
    editCardComment: (commentId, body) =>
      write(
        "basecamp comments update",
        run(cardCommentUpdateArgs(commentId, body)).pipe(Effect.asVoid)
      ),
    listSteps: (cardId) =>
      read(
        "basecamp cards steps",
        run(cardStepsArgs(board, cardId)).pipe(
          Effect.flatMap((result) => parseCardSteps(output(result)))
        )
      ),
    completeStep: (stepId) =>
      write(
        "basecamp cards step complete",
        run(cardStepCompleteArgs(board, stepId)).pipe(Effect.asVoid)
      ),
    listMessages: read(
      "basecamp messages list",
      run(messageListArgs(board)).pipe(Effect.flatMap((result) => parseMessages(output(result))))
    ),
    createMessage: (title, body) =>
      write(
        "basecamp messages create",
        run(messageCreateArgs(board, title, body)).pipe(
          Effect.flatMap((result) => parseMessage(output(result)))
        )
      ),
    listTodolists: read(
      "basecamp todolists list",
      run(todolistListArgs(board)).pipe(Effect.flatMap((result) => parseTodolists(output(result))))
    ),
    listTodos: (todolistId) =>
      read(
        "basecamp todos list",
        run(todoListArgs(board, todolistId)).pipe(
          Effect.flatMap((result) => parseTodos(output(result)))
        )
      )
  }
})
