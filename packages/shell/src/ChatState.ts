// @internal: the chat loop's persistent state, read and written only by the chat loop
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"

export const postedLimit = 500

export const chatDir = (repoPath: string, spaceId: string): string =>
  join(repoPath, ".llm4ts", "chat", spaceId)

export class ChatState extends Schema.Class<ChatState>("ChatState")({
  space: Schema.String,
  trigger: Schema.String,
  marker: Schema.String,
  cursor: Schema.String,
  posted: Schema.Array(Schema.String),
  ownerId: Schema.optional(Schema.String),
  baseBranch: Schema.String
}) {}

export class ChatRequest extends Schema.Class<ChatRequest>("ChatRequest")({
  messageName: Schema.String,
  createTime: Schema.String,
  sender: Schema.String,
  text: Schema.String,
  threadName: Schema.optional(Schema.String),
  status: Schema.Literals(["received", "answered", "started", "refused", "failed", "ended"]),
  action: Schema.optional(Schema.String),
  reply: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String)
}) {}

const StateJson = Schema.fromJsonString(ChatState)
const RequestJson = Schema.fromJsonString(ChatRequest)

const statePath = (dir: string): string => join(dir, "state.md")
const requestsPath = (dir: string): string => join(dir, "requests.md")

const persistenceError = (message: string, cause?: unknown): PersistenceError =>
  PersistenceError.make(cause === undefined ? { message } : { message, cause })

// Free text only ever appears as "> " quote lines or inside a JSON string (one
// line, newlines escaped), so a ```json line is always ours.
const jsonBlock = (json: string): string => `\`\`\`json\n${json}\n\`\`\``

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

/** The single-line JSON of each ```json block, in file order. */
const jsonBlocks = (markdown: string): ReadonlyArray<string> => {
  const lines = markdown.split("\n")
  const blocks: Array<string> = []
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] === "```json" && lines[i + 2] === "```") {
      blocks.push(lines[i + 1] ?? "")
      i += 2
    }
  }
  return blocks
}

export const renderState = (state: ChatState): string =>
  [
    "# Chat state",
    "",
    `- Space: ${state.space}`,
    `- Trigger: ${state.trigger}`,
    `- Cursor: ${state.cursor}`,
    `- Base branch: ${state.baseBranch}`,
    `- Posted messages: ${state.posted.length}`,
    "",
    jsonBlock(Schema.encodeSync(StateJson)(state)),
    ""
  ].join("\n")

export const parseState = (markdown: string): Effect.Effect<ChatState, PersistenceError> => {
  const block = jsonBlocks(markdown)[0]
  return block === undefined
    ? Effect.fail(persistenceError("chat state has no json block"))
    : Schema.decodeUnknownEffect(StateJson)(block).pipe(
        Effect.mapError((cause) => persistenceError("chat state json is invalid", cause))
      )
}

export const loadState = (
  files: PlainFileStoreShape,
  dir: string
): Effect.Effect<ChatState | undefined, PersistenceError> =>
  Effect.gen(function* () {
    const path = statePath(dir)
    const raw = yield* files.read(path)
    if (raw === undefined) return undefined
    return yield* parseState(raw).pipe(
      Effect.mapError((error) => persistenceError(`${path}: ${error.message}`, error))
    )
  })

export const saveState = (
  files: PlainFileStoreShape,
  dir: string,
  state: ChatState
): Effect.Effect<void, PersistenceError> => files.writeAtomic(statePath(dir), renderState(state))

export const notePosted = (state: ChatState, messageName: string): ChatState =>
  ChatState.make({ ...state, posted: [...state.posted, messageName].slice(-postedLimit) })

const renderRequest = (request: ChatRequest): string =>
  [
    `### ${request.messageName} (${request.status})`,
    "",
    `- From: ${request.sender} at ${request.createTime}`,
    "",
    quote(request.text),
    "",
    jsonBlock(Schema.encodeSync(RequestJson)(request)),
    ""
  ].join("\n")

export const loadRequests = (
  files: PlainFileStoreShape,
  dir: string
): Effect.Effect<ReadonlyArray<ChatRequest>, PersistenceError> =>
  Effect.gen(function* () {
    const path = requestsPath(dir)
    const raw = yield* files.read(path)
    if (raw === undefined) return []
    return yield* Effect.forEach(jsonBlocks(raw), (block) =>
      Schema.decodeUnknownEffect(RequestJson)(block).pipe(
        Effect.mapError((cause) =>
          persistenceError(`${path}: a request json block is invalid`, cause)
        )
      )
    )
  })

export const putRequest = (
  files: PlainFileStoreShape,
  dir: string,
  request: ChatRequest
): Effect.Effect<void, PersistenceError> =>
  Effect.gen(function* () {
    const existing = yield* loadRequests(files, dir)
    const next = existing.some((item) => item.messageName === request.messageName)
      ? existing.map((item) => (item.messageName === request.messageName ? request : item))
      : [...existing, request]
    yield* files.writeAtomic(
      requestsPath(dir),
      ["# Chat requests", "", ...next.map(renderRequest)].join("\n")
    )
  })
