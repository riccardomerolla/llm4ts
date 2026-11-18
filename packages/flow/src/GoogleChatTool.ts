import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { atLeastVersion, versionTriple } from "@llm4ts/core/providers/CliSupport"
import { ProcessError, type FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { guarded } from "./CapabilityGuard.ts"

export class SpaceRef extends Schema.Class<SpaceRef>("SpaceRef")({
  id: Schema.String
}) {
  get name(): string {
    return `spaces/${this.id}`
  }
}

export const parseSpaceRef = (input: string): SpaceRef | undefined => {
  const match = /^(?:spaces\/)?([A-Za-z0-9_-]+)$/.exec(input.trim())
  return match?.[1] === undefined ? undefined : new SpaceRef({ id: match[1] })
}

export class ChatMessage extends Schema.Class<ChatMessage>("ChatMessage")({
  name: Schema.String,
  createTime: Schema.String,
  text: Schema.String,
  senderName: Schema.optional(Schema.String),
  senderType: Schema.optional(Schema.String),
  senderDisplayName: Schema.optional(Schema.String),
  threadName: Schema.optional(Schema.String)
}) {}

export class GwsLoginRequired extends Schema.TaggedError<GwsLoginRequired>()("GwsLoginRequired", {
  message: Schema.String
}) {}

// gws's own message names the credentials-file variable; ours never echoes it.
const loginRequiredMessage = "Google login required. Run: gws auth login"

export const gwsVersionRange: { readonly min: string; readonly below: string } = {
  min: "0.22.5",
  below: "0.23.0"
}

const pageSize = 100

/** At most this many pages per listing: 5,000 messages between two beats is not a conversation. */
export const maxMessagePages = 50

export const messagesListArgs = (
  space: SpaceRef,
  after: string,
  pageToken?: string
): ReadonlyArray<string> => [
  "chat",
  "spaces",
  "messages",
  "list",
  "--params",
  JSON.stringify({
    parent: space.name,
    filter: `createTime > "${after}"`,
    orderBy: "createTime ASC",
    pageSize,
    ...(pageToken === undefined ? {} : { pageToken })
  })
]

export const messageCreateArgs = (
  space: SpaceRef,
  text: string,
  threadName?: string
): ReadonlyArray<string> => [
  "chat",
  "spaces",
  "messages",
  "create",
  "--params",
  JSON.stringify({
    parent: space.name,
    ...(threadName === undefined
      ? {}
      : { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" })
  }),
  "--json",
  JSON.stringify({
    text,
    ...(threadName === undefined ? {} : { thread: { name: threadName } })
  })
]

class GwsSender extends Schema.Class<GwsSender>("GwsSender")({
  name: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String)
}) {}

class GwsThread extends Schema.Class<GwsThread>("GwsThread")({
  name: Schema.optionalKey(Schema.String)
}) {}

class GwsMessage extends Schema.Class<GwsMessage>("GwsMessage")({
  name: Schema.String,
  createTime: Schema.String,
  text: Schema.optionalKey(Schema.String),
  sender: Schema.optionalKey(GwsSender),
  thread: Schema.optionalKey(GwsThread)
}) {}

class GwsMessagePage extends Schema.Class<GwsMessagePage>("GwsMessagePage")({
  messages: Schema.Array(GwsMessage).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze([])))
  ),
  nextPageToken: Schema.optionalKey(Schema.String)
}) {}

class GwsErrorBody extends Schema.Class<GwsErrorBody>("GwsErrorBody")({
  code: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String)
}) {}

class GwsErrorResponse extends Schema.Class<GwsErrorResponse>("GwsErrorResponse")({
  error: GwsErrorBody
}) {}

const toChatMessage = (message: GwsMessage): ChatMessage =>
  new ChatMessage({
    name: message.name,
    createTime: message.createTime,
    text: message.text ?? "",
    senderName: message.sender?.name,
    senderType: message.sender?.type,
    senderDisplayName: message.sender?.displayName,
    threadName: message.thread?.name
  })

export const parseMessages = (
  json: string
): Effect.Effect<
  { readonly messages: ReadonlyArray<ChatMessage>; readonly nextPageToken: string | undefined },
  ProcessError
> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GwsMessagePage))(json).pipe(
    Effect.map((page) => ({
      messages: page.messages.map(toChatMessage),
      nextPageToken: page.nextPageToken === "" ? undefined : page.nextPageToken
    })),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "gws chat spaces messages list",
        detail: `invalid message list JSON: ${String(error)}`
      })
    )
  )

export const parseMessage = (json: string): Effect.Effect<ChatMessage, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GwsMessage))(json).pipe(
    Effect.map(toChatMessage),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "gws chat spaces messages create",
        detail: `invalid message JSON: ${String(error)}`
      })
    )
  )

export const checkGwsVersion = (stdout: string): Effect.Effect<void, ProcessError> => {
  const range = `>= ${gwsVersionRange.min} and < ${gwsVersionRange.below}`
  const version = versionTriple(stdout)
  const min = versionTriple(gwsVersionRange.min) ?? []
  const below = versionTriple(gwsVersionRange.below) ?? []
  if (version === undefined) {
    return Effect.fail(
      ProcessError.make({
        message: "gws --version",
        detail: `could not read the gws version from '${stdout.trim()}'; llm4ts needs gws ${range}`
      })
    )
  }
  return atLeastVersion(version, min) && !atLeastVersion(version, below)
    ? Effect.void
    : Effect.fail(
        ProcessError.make({
          message: "gws --version",
          detail: `gws ${version.join(".")} is not supported; llm4ts needs gws ${range}`
        })
      )
}

const decodeGwsError = Schema.decodeUnknownOption(Schema.fromJsonString(GwsErrorResponse))

const isLoginRequired = (error: GwsErrorBody): boolean =>
  error.reason === "authError" || error.code === 401

/**
 * What a failed gws call says, without its own words: those can name the
 * credentials-file variable or a path. Only the envelope's code and reason.
 */
const failureDetail = (error: GwsErrorBody | undefined, exitCode: number): string => {
  const parts = [error?.code?.toString(), error?.reason].filter(
    (part): part is string => part !== undefined && part !== ""
  )
  return parts.length === 0 ? `exit code ${exitCode}` : `gws error ${parts.join(" ")}`
}

export interface GoogleChatToolShape {
  readonly probe: Effect.Effect<void, FlowError>
  readonly listMessages: (
    space: SpaceRef,
    after: string
  ) => Effect.Effect<ReadonlyArray<ChatMessage>, FlowError | GwsLoginRequired>
  readonly createMessage: (
    space: SpaceRef,
    text: string,
    threadName?: string
  ) => Effect.Effect<ChatMessage, FlowError | GwsLoginRequired>
}

const output = (result: ProcessResult): string => result.stdout.join("\n").trim()

export const makeGoogleChatTool = (
  process: ProcessExecutorShape,
  workDir: string,
  events: FlowEventsShape
): GoogleChatToolShape => {
  const run = (
    args: ReadonlyArray<string>
  ): Effect.Effect<ProcessResult, FlowError | GwsLoginRequired> =>
    process.run(["gws", ...args], workDir, {}).pipe(
      Effect.mapError((error) =>
        ProcessError.make({
          message: `gws ${args.join(" ")}`,
          detail: error.message
        })
      ),
      Effect.flatMap((result): Effect.Effect<ProcessResult, FlowError | GwsLoginRequired> => {
        if (result.exitCode === 0) return Effect.succeed(result)
        const decoded = decodeGwsError(output(result))
        const error = decoded._tag === "Some" ? decoded.value.error : undefined
        return error !== undefined && isLoginRequired(error)
          ? Effect.fail(GwsLoginRequired.make({ message: loginRequiredMessage }))
          : Effect.fail(
              ProcessError.make({
                message: `gws ${args.join(" ")}`,
                detail: failureDetail(error, result.exitCode)
              })
            )
      })
    )

  const gws = Capabilities.Exec("gws")
  const guard = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    guarded(gws, operation, events, effect)

  const listFailed = (detail: string): ProcessError =>
    ProcessError.make({ message: "gws chat spaces messages list", detail })

  const listPages = (
    space: SpaceRef,
    after: string,
    pageToken: string | undefined,
    seen: ReadonlySet<string>,
    collected: ReadonlyArray<ChatMessage>
  ): Effect.Effect<ReadonlyArray<ChatMessage>, FlowError | GwsLoginRequired> =>
    run(messagesListArgs(space, after, pageToken)).pipe(
      Effect.flatMap((result) => parseMessages(output(result))),
      Effect.flatMap((page) => {
        const messages = [...collected, ...page.messages]
        const token = page.nextPageToken
        if (token === undefined) return Effect.succeed(messages)
        if (seen.has(token)) return Effect.fail(listFailed("gws repeated a page token"))
        if (seen.size + 1 >= maxMessagePages) {
          return Effect.fail(listFailed(`more than ${maxMessagePages} pages of messages`))
        }
        return listPages(space, after, token, new Set([...seen, token]), messages)
      })
    )

  return {
    probe: guard(
      "gws --version",
      run(["--version"]).pipe(
        // `--version` needs no login; an auth envelope here is still a failed probe.
        Effect.catchTag("GwsLoginRequired", (error) =>
          Effect.fail(ProcessError.make({ message: "gws --version", detail: error.message }))
        ),
        Effect.flatMap((result) => checkGwsVersion(output(result)))
      )
    ),
    listMessages: (space, after) =>
      guard("gws chat spaces messages list", listPages(space, after, undefined, new Set(), [])),
    createMessage: (space, text, threadName) =>
      guard(
        "gws chat spaces messages create",
        run(messageCreateArgs(space, text, threadName)).pipe(
          Effect.flatMap((result) => parseMessage(output(result)))
        )
      )
  }
}
