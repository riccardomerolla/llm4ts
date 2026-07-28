import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  SessionDone,
  SessionResult,
  SessionTextDelta,
  SessionToolResult,
  SessionToolUse,
  SessionUsage,
  type AgentSessionShape,
  type SessionEvent
} from "../AgentSession.ts"
import { ProviderError, type LlmError } from "../Errors.ts"
import { TokenUsage } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import {
  jsonArray,
  jsonBooleanField,
  jsonField,
  jsonIntField,
  jsonStringField,
  jsonText,
  parseJsonLine,
  type JsonValue
} from "./CliSupport.ts"

export const claudeSessionArgv = (
  model: string | undefined,
  extraFlags: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "claude",
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  ...(model === undefined ? [] : ["--model", model]),
  ...extraFlags
]

export const claudeUserMessageJson = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: text
    }
  })

const contentBlocks = (json: JsonValue): ReadonlyArray<JsonValue> =>
  jsonArray(jsonField(jsonField(json, "message"), "content"))

const assistantEvents = (json: JsonValue): ReadonlyArray<SessionEvent> =>
  contentBlocks(json).flatMap((block): ReadonlyArray<SessionEvent> => {
    switch (jsonStringField(block, "type")) {
      case "text": {
        const text = jsonStringField(block, "text")
        return text === undefined || text.length === 0 ? [] : [SessionTextDelta.make({ text })]
      }
      case "tool_use":
        return [
          SessionToolUse.make({
            tool: jsonStringField(block, "name") ?? "",
            rawInput: jsonText(jsonField(block, "input") ?? {}),
            id: jsonStringField(block, "id") ?? ""
          })
        ]
      default:
        return []
    }
  })

const toolResultEvents = (json: JsonValue): ReadonlyArray<SessionEvent> =>
  contentBlocks(json).flatMap((block): ReadonlyArray<SessionEvent> => {
    if (jsonStringField(block, "type") !== "tool_result") {
      return []
    }
    const content = jsonField(block, "content")
    return [
      SessionToolResult.make({
        id: jsonStringField(block, "tool_use_id") ?? "",
        status: jsonBooleanField(block, "is_error") === true ? "error" : "success",
        content: content === undefined ? "" : jsonText(content)
      })
    ]
  })

const resultEvents = (json: JsonValue): ReadonlyArray<SessionEvent> => {
  const usage = jsonField(json, "usage")
  const usageEvents: ReadonlyArray<SessionEvent> =
    usage === undefined
      ? []
      : [
          SessionUsage.make({
            usage: TokenUsage.make({
              prompt: jsonIntField(usage, "input_tokens") ?? 0,
              completion: jsonIntField(usage, "output_tokens") ?? 0,
              total:
                (jsonIntField(usage, "input_tokens") ?? 0) +
                (jsonIntField(usage, "output_tokens") ?? 0),
              ...(jsonIntField(usage, "cache_read_input_tokens") === undefined
                ? {}
                : {
                    cached: jsonIntField(usage, "cache_read_input_tokens") ?? 0
                  })
            })
          })
        ]

  return [
    ...usageEvents,
    SessionDone.make({
      result: jsonStringField(json, "result") ?? ""
    })
  ]
}

export const parseClaudeSessionLine = (line: string): ReadonlyArray<SessionEvent> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }
  switch (jsonStringField(json, "type")) {
    case "assistant":
      return assistantEvents(json)
    case "user":
      return toolResultEvents(json)
    case "result":
      return resultEvents(json)
    default:
      return []
  }
}

export const claudeSessionInitModel = (line: string): string | undefined => {
  const json = parseJsonLine(line)
  return json !== undefined && jsonStringField(json, "type") === "system"
    ? jsonStringField(json, "model")
    : undefined
}

export const openClaudeAgentSession = Effect.fn("@llm4ts/core/providers/ClaudeAgentSession.open")(
  function* (
    executor: ProcessExecutorShape,
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>> = {}
  ): Effect.fn.Return<AgentSessionShape, LlmError, Scope.Scope> {
    const [stdin, stdout] = yield* executor.runBidirectional(argv, cwd, envVars)
    const events = yield* PubSub.unbounded<SessionEvent>()
    const done = yield* Deferred.make<SessionResult, LlmError>()
    const model = yield* Ref.make<string | undefined>(undefined)
    const text = yield* Ref.make("")
    const usage = yield* Ref.make<TokenUsage | undefined>(undefined)

    const trackEvent = Effect.fn("@llm4ts/core/providers/ClaudeAgentSession.trackEvent")(function* (
      event: SessionEvent
    ) {
      switch (event._tag) {
        case "TextDelta":
          yield* Ref.update(text, (current) => current + event.text)
          break
        case "Usage":
          yield* Ref.set(usage, event.usage)
          break
        case "Done": {
          const accumulated = yield* Ref.get(text)
          const finalUsage = yield* Ref.get(usage)
          const finalModel = yield* Ref.get(model)
          yield* Deferred.succeed(
            done,
            SessionResult.make({
              text: event.result.length === 0 ? accumulated : event.result,
              ...(finalUsage === undefined ? {} : { usage: finalUsage }),
              ...(finalModel === undefined ? {} : { model: finalModel })
            })
          )
          break
        }
        default:
          break
      }
      yield* PubSub.publish(events, event)
    })

    yield* stdout.pipe(
      Stream.mapEffect((line) => {
        const initializedModel = claudeSessionInitModel(line)
        return initializedModel === undefined
          ? Effect.succeed(line)
          : Ref.set(model, initializedModel).pipe(Effect.as(line))
      }),
      Stream.flatMap((line) => Stream.fromIterable(parseClaudeSessionLine(line))),
      Stream.mapEffect(trackEvent),
      Stream.runDrain,
      Effect.catch((error) => Deferred.fail(done, error).pipe(Effect.asVoid)),
      Effect.ensuring(
        Deferred.fail(
          done,
          ProviderError.make({
            message: "claude session ended before a result"
          })
        ).pipe(Effect.asVoid)
      ),
      Effect.forkScoped
    )

    const sendUserMessage = (message: string): Effect.Effect<void, LlmError> =>
      Queue.offer(stdin, claudeUserMessageJson(message)).pipe(Effect.asVoid)

    return {
      events: Stream.fromPubSub(events),
      sendUserMessage,
      respondToAsk: sendUserMessage,
      respondToApproval: (_id, _approved) => Effect.void,
      awaitResult: Deferred.await(done),
      cancel: Queue.shutdown(stdin)
    }
  }
)
